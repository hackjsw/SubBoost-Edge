# Worker Routing And Authentication

`edge/worker/index.ts` is the single request router. Public API and asset paths
are handled explicitly; authenticated application assets redirect anonymous
users to `/login`. Add a new API route beside related routes and preserve the
existing auth gate rather than rechecking cookies inconsistently in each
handler.

Handlers return helpers from `edge/worker/http.ts`: JSON responses are
`no-store` and `nosniff`; unsupported methods return 405 with an `Allow` header;
invalid JSON is handled at the boundary.

`edge/worker/auth.ts` verifies HMAC session cookies and stores login rate limits
in KV with a TTL. Secrets come only from `WorkerEnv` bindings. Never expose or
log `EDGE_ADMIN_PASSWORD`, `SESSION_SECRET`, `GITHUB_TOKEN`, session cookies,
subscription source URLs, or stored encrypted values.

Health endpoints may report whether KV/auth are configured, but must not return
secret values.
