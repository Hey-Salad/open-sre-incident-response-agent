import type { SessionStartLimiter } from "./session-start-limiter";

export const MIN_AUTH_SECRET_LENGTH = 32;
export const GLOBAL_SESSION_START_LIMIT = 10;
export const GLOBAL_SESSION_START_NAME = "session-start";
export const IP_ATTEMPT_LIMIT = 20;
export const IP_ATTEMPT_PERIOD_SECONDS = 60;

export interface SessionGuardEnv {
  SESSION_AUTH_SECRET?: string;
  SESSION_ATTEMPT_LIMITER: RateLimit;
  SESSION_START_LIMITER: DurableObjectNamespace<SessionStartLimiter>;
}

export function clientIpKey(request: Request): string {
  const ip = request.headers.get("CF-Connecting-IP")?.trim() ?? "";
  return ip.length > 0 ? `ip:${ip}` : "ip:unknown";
}

export async function guardSessionStart(request: Request, env: SessionGuardEnv): Promise<Response | null> {
  const attempt = await env.SESSION_ATTEMPT_LIMITER.limit({ key: clientIpKey(request) });
  if (!attempt.success) {
    return jsonResponse({ error: "Too many requests." }, 429, { "Retry-After": String(IP_ATTEMPT_PERIOD_SECONDS) });
  }

  const secret = env.SESSION_AUTH_SECRET ?? "";
  if (secret.length < MIN_AUTH_SECRET_LENGTH) {
    return jsonResponse({ error: "Session auth is not configured." }, 503);
  }

  if (!(await bearerMatches(request, secret))) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }

  const globalLimiter = env.SESSION_START_LIMITER.getByName(GLOBAL_SESSION_START_NAME);
  const decision = await globalLimiter.consume(GLOBAL_SESSION_START_LIMIT);
  if (!decision.allowed) {
    return jsonResponse({ error: "Too many requests." }, 429, { "Retry-After": String(decision.retryAfterSeconds) });
  }

  return null;
}

function bearerMatches(request: Request, secret: string): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return timingSafeEqual(match?.[1] ?? "", secret);
}

async function timingSafeEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function jsonResponse(body: unknown, status: number, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body, null, 2), { status, headers });
}
