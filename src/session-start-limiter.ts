import { DurableObject } from "cloudflare:workers";

const WINDOW_MS = 60_000;

export type LimitDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export class SessionStartLimiter extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS hits (
          at INTEGER NOT NULL
        )
      `);
    });
  }

  async consume(limit: number): Promise<LimitDecision> {
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      const windowStart = now - WINDOW_MS;
      this.ctx.storage.sql.exec(`DELETE FROM hits WHERE at <= ?`, windowStart);
      const count = Number(this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM hits`).one().n);
      if (count >= limit) {
        const oldest = Number(this.ctx.storage.sql.exec<{ at: number }>(`SELECT MIN(at) AS at FROM hits`).one().at);
        const retryAfterSeconds = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
        return { allowed: false, retryAfterSeconds };
      }
      this.ctx.storage.sql.exec(`INSERT INTO hits (at) VALUES (?)`, now);
      return { allowed: true, retryAfterSeconds: 0 };
    });
  }
}
