# Dashboard Adapters

`edge/app/page.tsx` and `edge/app/dashboard/page.tsx` construct typed adapters
and render `@subboost/ui` surfaces. Keep Cloudflare endpoint URLs, methods,
feature availability, and auto-update policy in those adapters.

Use a small response helper at the adapter boundary to parse JSON and throw the
server's `error` message for non-OK responses. Authenticated dashboard reads
must use `cache: "no-store"`.

Use existing surface extension slots for Edge-only operational controls before
forking a shared dashboard. When a feature is useful in both runtimes, extend
the shared adapter contract and implement it in both pages.
