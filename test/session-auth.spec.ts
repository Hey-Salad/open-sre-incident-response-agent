import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src";
import type { Env } from "../src/env";
import {
  GLOBAL_SESSION_START_LIMIT,
  GLOBAL_SESSION_START_NAME,
  IP_ATTEMPT_LIMIT,
  MIN_AUTH_SECRET_LENGTH,
} from "../src/session-auth";
import { network } from "./network";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const SECRET = "s".repeat(MIN_AUTH_SECRET_LENGTH);

let outboundCalls = 0;

function sessionEnv(options: { secret?: string; limiter?: RateLimit } = {}): Env {
  const overrides: Record<string, unknown> = {
    SESSION_AUTH_SECRET: options.secret === undefined ? SECRET : options.secret,
    OPENAI_API_KEY: "test-openai-key",
    OPENAI_BASE_URL: "https://api.example.test/v1",
    OPENAI_PROJECT: "proj_test",
    AGENTS_ENVIRONMENT_TYPE: "none",
  };
  if (options.limiter) overrides.SESSION_ATTEMPT_LIMITER = options.limiter;

  return new Proxy(env, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && Object.prototype.hasOwnProperty.call(overrides, prop)) {
        return overrides[prop];
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Env;
}

async function callWorker(request: Request, options: { secret?: string; limiter?: RateLimit } = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, sessionEnv(options), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function sessionRequest(options: { ip?: string; token?: string } = {}): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.ip !== undefined) headers.set("CF-Connecting-IP", options.ip);
  if (options.token !== undefined) headers.set("Authorization", `Bearer ${options.token}`);
  return new IncomingRequest("https://worker.example/api/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({ input: "triage" }),
  });
}

function allowUpstream(): void {
  network.use(
    http.post("https://api.example.test/v1/agents", () => {
      outboundCalls += 1;
      return HttpResponse.json({ id: "agent_test" });
    }),
    http.post("https://api.example.test/v1/agents/sessions", () => {
      outboundCalls += 1;
      return new HttpResponse("data: hello\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }),
  );
}

async function resetGlobalLimiter(): Promise<void> {
  const stub = env.SESSION_START_LIMITER.getByName(GLOBAL_SESSION_START_NAME);
  await runInDurableObject(stub, async (_instance, state) => {
    try {
      state.storage.sql.exec(`DELETE FROM hits`);
    } catch {
      // The table is created on first use of this instance.
    }
  });
}

describe.sequential("session start auth and limits", () => {
  beforeEach(async () => {
    outboundCalls = 0;
    network.use(
      http.all("https://api.example.test/*", () => {
        outboundCalls += 1;
        return HttpResponse.json({ error: "unexpected upstream" }, { status: 500 });
      }),
    );
    await resetGlobalLimiter();
  });

  it("serves health and the home page without a bearer", async () => {
    const health = await callWorker(new IncomingRequest("https://worker.example/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, service: "open-sre-incident-response-agent" });

    const home = await callWorker(new IncomingRequest("https://worker.example/"));
    expect(home.status).toBe(200);
    expect(home.headers.get("Content-Type")).toContain("text/html");
    expect(await home.text()).toContain("Session token");

    const missing = await callWorker(new IncomingRequest("https://worker.example/missing"));
    expect(missing.status).toBe(404);
    expect(outboundCalls).toBe(0);
  });

  it("uses ip:unknown when CF-Connecting-IP is missing and ip: plus the header otherwise", async () => {
    const keys: string[] = [];
    const limiter: RateLimit = {
      async limit({ key }) {
        keys.push(key);
        return { success: false };
      },
    };

    const missing = await callWorker(sessionRequest({ token: SECRET }), { limiter });
    const blank = await callWorker(sessionRequest({ ip: "   ", token: SECRET }), { limiter });
    const addressed = await callWorker(sessionRequest({ ip: " 203.0.113.10 ", token: "wrong" }), { limiter });

    expect(missing.status).toBe(429);
    expect(blank.status).toBe(429);
    expect(addressed.status).toBe(429);
    expect(keys).toEqual(["ip:unknown", "ip:unknown", "ip:203.0.113.10"]);
    expect(outboundCalls).toBe(0);
  });

  it("returns 503 before the bearer check when the auth secret is shorter than 32 characters", async () => {
    const shortSecret = "s".repeat(MIN_AUTH_SECRET_LENGTH - 1);
    const response = await callWorker(sessionRequest({ ip: "203.0.113.20", token: shortSecret }), {
      secret: shortSecret,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Session auth is not configured." });
    expect(outboundCalls).toBe(0);

    const missingSecret = await callWorker(sessionRequest({ ip: "203.0.113.21", token: SECRET }), { secret: "" });
    expect(missingSecret.status).toBe(503);
    expect(outboundCalls).toBe(0);
  });

  it("returns 401 for a missing or wrong bearer after the attempt limit allows the request", async () => {
    const missing = await callWorker(sessionRequest({ ip: "203.0.113.30" }));
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "Unauthorized." });

    const wrong = await callWorker(sessionRequest({ ip: "203.0.113.31", token: "not-the-secret" }));
    expect(wrong.status).toBe(401);
    expect(outboundCalls).toBe(0);
  });

  it("blocks further attempts from the same IP before checking the bearer", async () => {
    const ip = "203.0.113.40";
    for (let attempt = 0; attempt < IP_ATTEMPT_LIMIT; attempt += 1) {
      const response = await callWorker(sessionRequest({ ip, token: "wrong-token" }));
      expect(response.status).toBe(401);
    }

    const blocked = await callWorker(sessionRequest({ ip, token: SECRET }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect(await blocked.json()).toEqual({ error: "Too many requests." });

    const otherIp = await callWorker(sessionRequest({ ip: "203.0.113.41", token: "wrong-token" }));
    expect(otherIp.status).toBe(401);
    expect(outboundCalls).toBe(0);
  });

  it("starts a session for a valid bearer and then enforces the global cap across IPs", async () => {
    allowUpstream();

    for (let start = 0; start < GLOBAL_SESSION_START_LIMIT; start += 1) {
      const response = await callWorker(sessionRequest({ ip: `203.0.113.${50 + start}`, token: SECRET }));
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/event-stream");
      expect(await response.text()).toContain("agent_test");
    }

    const capped = await callWorker(sessionRequest({ ip: "203.0.113.80", token: SECRET }));
    expect(capped.status).toBe(429);
    expect(Number(capped.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await capped.json()).toEqual({ error: "Too many requests." });
    expect(outboundCalls).toBe(GLOBAL_SESSION_START_LIMIT * 2);
  });

  it("drops global hits once they are older than 60 seconds", async () => {
    const stub = env.SESSION_START_LIMITER.getByName("window-expiry");
    await stub.consume(GLOBAL_SESSION_START_LIMIT);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM hits`);
      const stale = Date.now() - 61_000;
      for (let hit = 0; hit < GLOBAL_SESSION_START_LIMIT; hit += 1) {
        state.storage.sql.exec(`INSERT INTO hits (at) VALUES (?)`, stale);
      }
    });

    const decision = await stub.consume(GLOBAL_SESSION_START_LIMIT);
    expect(decision.allowed).toBe(true);
  });
});
