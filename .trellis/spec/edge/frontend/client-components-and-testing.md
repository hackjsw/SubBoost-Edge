# Client Components And Testing

Edge-only client components belong under `edge/src/components`. They may own
local request/loading state and call a typed page adapter or documented Worker
endpoint. Reuse buttons, icons, toast, and typography from `@subboost/ui`.

Page adapter tests should mock the shared surface and capture its adapter, as in
Local page tests. Shared surface behavior remains tested under `packages/ui`.
For a server-backed status control, cover initial loading, successful data,
failure, disabled refresh, and the post-refresh response.

Rule catalog responses cross an untrusted JSON boundary: use the shared runtime
decoder, accept only HTTP(S) source links and consistent non-negative integer
counts, and keep raw payload casts out of the component. If a later read fails
after usable status has loaded, retain the counts and show an inline retry alert.

Edge-only panels must use explicit light workbench foreground, muted, border,
and surface colors. Shared `text-white` or dark `bg-[#141414]` tokens can be
rewritten asymmetrically by `edge-light.css`, so do not pair them in a new Edge
panel. Verify the computed result in desktop and mobile browser screenshots.

Do not import Worker modules or environment bindings into the static Next.js
bundle.
