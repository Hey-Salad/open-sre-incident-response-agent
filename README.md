# SRE Incident Response Agent

Runnable Cloudflare Worker and curl-first example for the OpenAI Agents API. It creates a reusable agent named `SRE agent for incident response`, starts a streamed session from the returned `agent_id`, and streams raw session events.

## Files

- `config/agent-definition.json` contains the reusable agent definition.
- `config/session-input.txt` contains the initial user message.
- `scripts/run-agent-session.sh` calls the Agents HTTP API directly with `curl`.
- `src/index.ts` is a Cloudflare Worker UI/API layer that mirrors the same flow.

## Setup

```bash
npm install
export OPENAI_API_KEY="your-api-key"
```

The app uses OpenAI project `proj_mRsQVx3NjOamxeXH6UrLowoC` via the `OpenAI-Project` header by default.

## Run Locally

```bash
npm test
npm run typecheck
npm run run:agent
npm run dev
```

## Session start

`POST /api/sessions` requires `Authorization: Bearer` set to the `SESSION_AUTH_SECRET` Worker secret. The secret must be at least 32 characters. A shorter or missing secret returns 503. A mismatch returns 401.

Each attempt is counted before the bearer is checked. The key is `ip:` plus the `CF-Connecting-IP` header, or `ip:unknown` when that header is absent. The attempt limit is 20 requests per 60 seconds. After a valid bearer, a Durable Object caps session starts at 10 per 60 seconds for the whole worker.

The worker name is `open-sre-incident-response-agent`. Its rate-limit namespace id is `51005`. See `rollout/README.md`.

## Deploy To Cloudflare Workers

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put SESSION_AUTH_SECRET
npm run deploy
```

Default Agents API environment is `openai_hosted`. Set `AGENTS_ENVIRONMENT_TYPE=none` only when no sandbox is needed.
