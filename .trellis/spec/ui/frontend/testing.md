# Testing Shared UI

UI tests run in Vitest's Node environment. Use the repository's existing light
render/mocking patterns rather than adding a browser test framework for a small
component change.

- Adapter tests inject `fetchImpl` and assert URL, method, cache, and decoded
  response (`packages/ui/src/product/api-adapter.test.ts`).
- Store tests reset with `setState`, inspect with `getState`, and mock fetch
  (`packages/ui/src/store/user-store.test.ts`).
- Surface tests mock stores/providers and build a typed adapter with `vi.fn()`
  methods (`template-library-surface.test.ts`).
- Small render contracts can use `renderToStaticMarkup` and mocked icons.
- Toaster behavior is tested as a queue with fake timers in
  `components/ui/toaster.test.ts`.

Cover initial loading, success, empty, failure, mutation-in-progress, and
post-mutation state when adding a server-backed dashboard control.
