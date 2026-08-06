# Testing Local Backend

- Route contract tests under `local/test` mock auth/services and import the
  route module to verify methods, status codes, and response bodies.
- Route-specific suites beside `local/app/api` cover auth, setup, health, and
  release behavior.
- Service tests under `local/src/lib` mock Prisma, crypto, transports, and
  server-core orchestration.

Use Vitest module mocks at real ownership boundaries. Assert admin scoping,
failure mapping, and persistence side effects. Do not require a live Postgres
instance for unit tests unless the task explicitly adds an integration suite.
