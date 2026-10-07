# Rollout identifiers

This worker uses its own Worker name and rate-limit namespace. Bindings that share a `namespace_id` share counters across Workers on the same Cloudflare account, so this id must not be copied onto another worker.

| Field | Value |
| --- | --- |
| Worker name | `open-sre-incident-response-agent` |
| Pre-auth attempt limiter binding | `SESSION_ATTEMPT_LIMITER` |
| Pre-auth attempt namespace id | `51005` |
| Pre-auth attempt limit | 20 requests / 60 seconds |
| Attempt key | `ip:` + `CF-Connecting-IP`, or `ip:unknown` |
| Global session-start class | `SessionStartLimiter` |
| Global session-start binding | `SESSION_START_LIMITER` |
| Global session-start instance | `session-start` |
| Global session-start cap | 10 starts / 60 seconds |
| Migration tag | `v1` |

`SESSION_AUTH_SECRET` is a Worker secret of at least 32 characters. Do not commit it.
