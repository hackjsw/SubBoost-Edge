# @subboost/core Frontend Guidelines

Core exports browser-safe domain contracts used by `@subboost/ui`. It contains
no React components or client state of its own.

## Guidelines

- [Browser contracts](./browser-contracts.md)
- [Backend domain pipeline](../backend/domain-pipeline.md)
- [Shared tests](../backend/testing.md)

## Pre-Development Checklist

- Read the exact exported type and all UI consumers before changing it.
- Use a specific package subpath rather than expanding the root barrel without
  a reason.
- Confirm the implementation remains browser-safe.

## Quality Check

- Run `npm run test:core` and the affected UI suite with
  `npx vitest run <packages/ui/src/...test.ts>`.
- Confirm UI code consumes typed results rather than parsing generated YAML or
  casting unknown payload fields locally.
