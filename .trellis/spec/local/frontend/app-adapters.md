# Application Adapters

Pages under `local/app` should be thin. `local/app/page.tsx` constructs a
`HomeSurfaceAdapter`; `local/app/dashboard/page.tsx` constructs a
`DashboardSurfaceAdapter`; both render the shared surface from `@subboost/ui`.

Keep endpoint paths and Local-only capabilities in these adapter objects.
Decode API responses at the page adapter boundary. Do not fork a shared surface
just to change a route URL or enable a capability.

`local/app/layout.tsx` owns runtime shell composition: shared footer, mobile
navigation, toaster, and confirmation host plus the Local header. Product
feature markup belongs in `packages/ui` when both runtimes use it.
