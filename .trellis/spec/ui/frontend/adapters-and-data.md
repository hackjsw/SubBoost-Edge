# Adapters And Data Flow

Shared surfaces define what they need; runtime pages implement it. The main
examples are `HomeSurfaceAdapter`, `DashboardSurfaceAdapter`, and
`TemplateLibraryAdapter`.

- Keep endpoint paths, methods, and runtime capabilities in the application
  adapter (`local/app/...` or `edge/app/...`).
- Parse unknown JSON once in an adapter helper and throw a useful `Error` for a
  non-OK response.
- Use `cache: "no-store"` for authenticated dashboard state.
- After a mutation, re-fetch the canonical list rather than hand-maintaining a
  second server-state model.
- Use `AbortSignal` when the surface supports cancellation.

The product API and interaction providers currently also expose module-level
active adapters. Treat those globals as compatibility behavior: do not extend
their use into new concurrent or server-rendered code. Prefer the React context
hook inside components.
