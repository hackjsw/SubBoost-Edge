# @subboost/edge Worker Guidelines

`edge/worker` owns Cloudflare routing, authentication, KV persistence, remote
fetch policy, subscription APIs, rule catalog synchronization, and cron jobs.

## Guidelines

- [Routing and authentication](./worker-routing-and-auth.md)
- [KV, cron, and rules](./kv-cron-and-rules.md)
- [Stored subscription conversion](./stored-subscription-conversion.md)
- [Testing](./testing.md)

## Pre-Development Checklist

- Trace the route from `edge/worker/index.ts` to its handler and shared service.
- Identify whether the route is public, authenticated, or scheduled-only.
- Read the KV schema/key, TTL behavior, and existing MemoryKv tests.
- Check both cron expressions in `edge/wrangler.jsonc` before changing schedule
  dispatch.

## Quality Check

- Run focused Worker tests with
  `npx vitest run edge/worker/index.test.ts` and run
  `npm run edge:typecheck`.
- Run `npm run test:unit` for shared service/API changes.
- Verify method guards, auth, no-store headers, KV-unavailable behavior, and cron
  dispatch without relying on a real Cloudflare account.
