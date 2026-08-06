# Service Contracts

Server-core orchestrators accept callbacks for environment-specific I/O and
return structured results.

- `packages/server-core/src/subscription/source-import.ts` defines the transport
  request and separates successful imports from structured failures.
- `refresh-node-snapshot.ts` accepts injected URL/provider fetchers and returns
  node counters plus `failedSources` metadata.
- `refresh-cache-result.ts` returns a discriminated success or a failure reason
  (`all_sources_failed`, `empty_result`, or `node_quota_exceeded`).
- `crud.ts` normalizes and serializes stable summary/detail DTOs without owning
  a database.
- `packages/server-core/src/http.ts` owns the shared `{ error, code }` API error
  body shape.

Preserve discriminants and metadata when extending a result. Applications must
be able to map every branch without inspecting an error message string.

Do not put Prisma, KV, Next.js request objects, or Worker environment bindings
inside these orchestrators. `local/src/lib/subscription-service.ts` and
`edge/worker/edge-api.ts` demonstrate the adapter boundary.
