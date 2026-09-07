# Technical design

## Boundaries

Work is organized around four seams: (1) build/release tooling, (2) Edge/server remote-input and persistence boundaries, (3) local runtime/container, and (4) UI/parser delivery. Each seam owns its tests and can be rolled back independently. Existing uncommitted WIP remains the baseline; edits must be additive or narrowly corrective.

## Data and control flow

- Archive: resolve the repository root, obtain a tracked/allowlisted manifest, copy only approved files into a temporary staging directory, write `SOURCE_INFO.txt`, compute SHA-256, then atomically publish the archive.
- Import: request enters the API, passes URL/auth/size/deadline policy, uses a bounded transport pool, parses/sniffs the payload, optionally performs one deduplicated user-info request, and returns normalized error metadata. Refresh callbacks reuse the same importer and share a total budget.
- Stored config: writes increment a per-token generation/invalidation marker; cache reads capture the marker before awaiting KV and discard results if it changed. Public cache bypass is removed or limited to an authenticated administrative path.
- Release: quality checks and immutable assets complete before tag/latest pointer mutation. Asset generation validates a canonical child path and replaces output atomically.
- UI: semantic labels/ARIA are colocated with controls; effects use abort/cleanup guards; expensive parser/generator work is loaded lazily or precompiled.

## Compatibility and rollout

Keep response schemas backward-compatible where possible. Existing `raw=1` subscription URLs continue to work; only the undocumented public `force=1` cache bypass is removed/restricted. If a deployment lacks a capability (e.g. Docker BuildKit healthcheck or Git metadata), fail with an actionable message rather than silently widening the boundary. Roll back by reverting each seam's commit; no data migration is required.

## Trade-offs

An explicit allowlist and bounded pools are intentionally conservative: a new product file requires an allowlist update, and some slow/large sources will fail earlier. This is preferable to leaking worktree data or exceeding Cloudflare request limits. Production-only Docker dependencies may require migrations to run in a separate job; the image must not regain a full development toolchain just to preserve an implicit startup side effect.
