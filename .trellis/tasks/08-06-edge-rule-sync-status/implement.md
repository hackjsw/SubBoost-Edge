# Implementation Plan

1. Add the shared response contract/decoder, then status projection and handlers
   in `edge/worker/rules-api.ts`.
   - Verify direct KV reads, bundled fallback, next-run calculation, and refresh
     outcome mapping with Worker tests.
2. Register authenticated routes and reuse the exported cron constant in
   `edge/worker/index.ts`.
   - Verify anonymous 401 and method 405 behavior.
3. Add `RuleLibraryStatus` and its focused tests, then inject it in the Edge
   dashboard `beforeStatsSlot`.
   - Verify loading, success, error, and refreshing markup.
4. Update README deployment URL and API table.
5. Run:
   - `npx vitest run edge/worker/index.test.ts edge/src/components/rule-library-status.test.ts`
   - `npm run lint`
   - `npm run edge:typecheck`
   - `npm run edge:build`
   - `npm run test:unit`
6. Review against Edge backend/frontend and UI frontend Trellis specs, commit,
   push `main`, deploy with `npm run edge:deploy`, and verify production health,
   login, status, and refresh authorization behavior.

## Rollback Points

- Worker API changes are additive and can be reverted without migrating KV.
- Dashboard injection is isolated to the Edge page adapter.
- Do not alter cron frequency or delete the existing rule index during rollback.
