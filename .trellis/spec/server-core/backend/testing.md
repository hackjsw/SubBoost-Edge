# Testing Server Orchestration

Tests are colocated and use Vitest. Inject `vi.fn()` transports and persistence
callbacks instead of starting an HTTP server or database.

Reference suites:

- `source-import.test.ts` for URL validation, transport calls, headers, and
  structured error categories.
- `refresh-node-snapshot.test.ts` for mixed static/URL/provider sources,
  counters, and failed source metadata.
- `refresh-cache-result.test.ts` for exhaustive result-union branches.
- `local/src/lib/auto-update-service.test.ts` for application adapter wiring.

Use `vi.mock` for module boundaries, `mockResolvedValueOnce` for ordered remote
attempts, and restore mocks between tests. Assert the result contract and
adapter side effects, not private helper call order unless order is itself the
contract.
