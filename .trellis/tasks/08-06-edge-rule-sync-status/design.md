# Design: Edge Rule Sync Status

## Boundaries

- `edge/worker/rules-api.ts` owns rule catalog KV decoding, status projection,
  next-run calculation, and the two HTTP handlers.
- `edge/worker/index.ts` owns authenticated route registration and continues to
  dispatch the daily cron through `runScheduledRuleCatalogUpdate`.
- `edge/src/components/rule-library-status.tsx` owns Edge-only client state and
  presentation.
- `edge/src/lib/rule-catalog-status.ts` owns the shared Edge API response types
  and runtime decoders used at the browser boundary.
- `edge/app/dashboard/page.tsx` injects the component through the existing
  `beforeStatsSlot`; shared dashboard contracts do not change.

## API Contract

`GET /api/rules/status` returns:

```ts
type RuleCatalogStatus = {
  source: "remote" | "stale" | "bundled";
  sourceLabel: "MetaCubeX/meta-rules-dat";
  sourceUrl: string;
  geositeCount: number;
  geoipCount: number;
  totalRules: number;
  fetchedAt: number | null;
  expiresAt: number | null;
  schedule: "17 3 * * *";
  nextScheduledAt: number;
};
```

The status handler reads `SUB_KV` directly and never calls the upstream. A
valid but expired remote index is projected as `stale`. Missing or invalid KV
data is projected from the bundled index with null remote timestamps.

`POST /api/rules/refresh` calls `refreshRuleIndex({ force: true })` through the
existing catalog service and returns the same status fields plus
`refreshStatus` and an optional sanitized `error`. Refreshed/skipped responses
use HTTP 200. A stale response also uses HTTP 200 so the UI can retain and show
the usable catalog with a warning. An unavailable result uses HTTP 503.

Both routes are protected by the existing router-level session check.

## Scheduling

Export one `RULE_CATALOG_CRON` constant from `rules-api.ts` for Worker dispatch
and API reporting. Calculate the next 03:17 UTC occurrence with a small fixed
schedule helper; do not add a cron parsing dependency. `edge/wrangler.jsonc`
remains the deployment source of trigger registration and must match the
constant.

## UI

The status panel is a single bordered workbench section, not nested cards. It
uses a database icon, a compact source badge, four scan-friendly facts, local
date formatting, and a `RefreshCw` command button. Loading placeholders retain
the panel dimensions. Errors keep a retry-capable panel instead of removing the
section. Toast variants distinguish successful refresh, stale fallback, and
hard failure.

## Compatibility And Risk

- Existing search/CN-candidate API contracts and rule KV schema do not change.
- Status adds one KV read per authenticated dashboard load and no upstream
  request.
- The catalog service already coalesces in-flight refreshes per Worker instance;
  Cloudflare KV has no cross-instance compare-and-set lock. The client disables
  duplicate submits, and no distributed lock is claimed.
- Rollback is removal of the two routes and dashboard slot; the stored KV index
  remains compatible.
