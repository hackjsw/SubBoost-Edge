# KV, Cron, And Rule Catalog

KV keys are versioned constants owned by the module that reads and writes them.
Rule catalog data uses `RULE_INDEX_CACHE_KEY = "edge-rule-index:v1"` in
`edge/worker/rules-api.ts`. Parse stored JSON defensively before exposing it.

The rule catalog service is created from `@subboost/server-core/rules` with an
injected KV cache. A missing or invalid remote cache falls back to the bundled
rule index and reports `source: "stale"`; unavailable remote refreshes must not
discard a usable stale index.

`edge/wrangler.jsonc` defines two schedules:

- `*/15 * * * *` scans due saved subscriptions.
- `17 3 * * *` refreshes the rule catalog once daily.

`edge/worker/index.ts` dispatches by the actual cron string. Do not refresh the
rule catalog every 15 minutes: GitHub fetches and KV writes are unnecessary at
that frequency. Manual admin refresh should reuse the same forced service
refresh as the daily cron and return the resulting source/timestamps.

Module-level single-flight state can reduce duplicate work within one Worker
instance but is not a distributed KV lock. UI controls must disable repeated
submits, and server code should avoid adding assumptions of atomic compare-and-
set to `KVNamespaceLike`.
