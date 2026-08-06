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

## Scenario: Authenticated rule catalog status and refresh

### 1. Scope / Trigger

- Trigger: expose the KV-backed rule catalog across Worker API and static Edge
  dashboard layers without adding an upstream request to dashboard reads.

### 2. Signatures

- `GET /api/rules/status` returns the current catalog projection.
- `POST /api/rules/refresh` calls `refreshRuleIndex({ force: true })`.
- `RULE_CATALOG_CRON` and `getNextRuleCatalogRunAt(now)` are exported from
  `edge/worker/rules-api.ts`; the constant must match `edge/wrangler.jsonc`.

### 3. Contracts

- A successful status response contains `source` (`remote`, `stale`, or
  `bundled`), `sourceLabel`, an HTTP(S) `sourceUrl`, non-negative integer
  `geositeCount`, `geoipCount`, and `totalRules`, nullable `fetchedAt` and
  `expiresAt`, `schedule`, and `nextScheduledAt`.
- `totalRules` equals `geositeCount + geoipCount`. Timestamps are epoch
  milliseconds; `nextScheduledAt` is the next 03:17 UTC occurrence.
- A successful refresh adds `refreshStatus` (`skipped`, `refreshed`, or
  `stale`) and may add a public `error` for the stale-cache warning.
- Status reads `SUB_KV` directly and never contacts GitHub. Refresh may use the
  optional `GITHUB_TOKEN` through the existing service.
- Browser code parses JSON as `unknown` through the shared Edge decoder before
  rendering it or assigning `sourceUrl` to an anchor.

### 4. Validation & Error Matrix

- Anonymous request -> `401` through the router auth gate.
- Wrong method -> `405` with `Allow: GET` or `Allow: POST`.
- Missing KV binding -> `503` with `{ error: "KV未绑定" }`.
- Missing or invalid stored index -> `200` bundled projection with null remote
  timestamps.
- Expired valid index -> `200` stale projection that preserves its counts.
- Refresh failure with a usable index -> `200` stale projection and a stable,
  sanitized warning.
- Refresh failure without a usable service -> `503` with a stable, sanitized
  error. Never return a GitHub response body or raw service exception.

### 5. Good / Base / Bad Cases

- Good: a forced refresh stores a remote index and reports exact counts.
- Base: a fresh dashboard load performs one KV read and reports the next cron.
- Bad: upstream failure retains the stale index; invalid KV falls back to the
  bundled catalog instead of deleting data or failing the dashboard.

### 6. Tests Required

- Worker tests assert auth, method guards, `Allow`, `no-store`, exact counts,
  timestamps, no upstream call during status, bundled/stale fallbacks, sanitized
  refresh errors, and both cron dispatch values.
- Component tests assert runtime decoder rejection for unsafe URLs or invalid
  counts, stable loading/error/refreshing states, and retained usable status.
- Build and responsive browser checks verify the light dashboard on desktop and
  mobile without overlap.

### 7. Wrong vs Correct

#### Wrong

```ts
return json({ error: result.error }, 503);
```

#### Correct

```ts
return json({ error: "远端规则目录同步失败，请稍后重试" }, 503);
```
