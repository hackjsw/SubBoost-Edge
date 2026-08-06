# @subboost/edge Frontend Guidelines

The Edge Next.js build produces static assets. Runtime behavior comes from the
Cloudflare Worker, while pages remain thin adapters around shared UI surfaces.

## Guidelines

- [Dashboard adapters](./dashboard-adapters.md)
- [Client components and tests](./client-components-and-testing.md)

## Pre-Development Checklist

- Read the shared surface adapter and the equivalent Local page adapter.
- Confirm the Worker endpoint and auth behavior before wiring client fetches.
- Keep the light EdgeSub workbench style and reuse shared UI primitives.

## Quality Check

- Run focused UI tests, `npm run edge:typecheck`, and `npm run lint`.
- Run `npm run edge:build` for page or static-export changes.
- Verify loading, unavailable, mutation-in-progress, and success states.
