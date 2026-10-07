import type { SessionStartLimiter } from "./session-start-limiter";

declare global {
  namespace Cloudflare {
    interface Env {
      OPENAI_API_KEY: string;
      OPENAI_PROJECT: string;
      OPENAI_BASE_URL: string;
      AGENTS_ENVIRONMENT_TYPE: string;
      SESSION_AUTH_SECRET?: string;
      SESSION_ATTEMPT_LIMITER: RateLimit;
      SESSION_START_LIMITER: DurableObjectNamespace<SessionStartLimiter>;
    }
  }
}

export type Env = Cloudflare.Env;
