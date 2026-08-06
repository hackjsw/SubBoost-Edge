# API Adapter Contracts

`packages/ui/src/product/api-adapter.tsx` defines optional source-import,
template, and rule capabilities. Runtime pages supply the available behavior;
shared surfaces must not assume every deployment supports every feature.

`createRulesProductApi` accepts endpoint overrides and an injected `fetchImpl`,
uses `cache: "no-store"`, forwards `AbortSignal`, and decodes JSON at the
adapter boundary. Follow that pattern for reusable API clients.

`packages/ui/src/lib/utils.ts` provides `readApiErrorMessage`: prefer the
server's JSON `error`, then fall back to the HTTP status. Do not parse the same
response independently inside several components.

Authentication and persistence remain runtime responsibilities. Shared UI may
call an adapter, but it must not import Worker bindings, Prisma, or a route
handler.
