# Testing Local Frontend Adapters

`local/app/local-pages.test.ts` mocks shared surfaces/components and captures
the adapter passed by each page. Follow that pattern to test routes, methods,
capabilities, and shell composition without rendering the entire product UI.

Colocate focused component tests under `local/src/components`. Keep API route
contracts under `local/test` or beside the route, as described by the Local
backend specification.
