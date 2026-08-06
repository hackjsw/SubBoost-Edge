# Client Components And Testing

Edge-only client components belong under `edge/src/components`. They may own
local request/loading state and call a typed page adapter or documented Worker
endpoint. Reuse buttons, icons, toast, and typography from `@subboost/ui`.

Page adapter tests should mock the shared surface and capture its adapter, as in
Local page tests. Shared surface behavior remains tested under `packages/ui`.
For a server-backed status control, cover initial loading, successful data,
failure, disabled refresh, and the post-refresh response.

Do not import Worker modules or environment bindings into the static Next.js
bundle.
