# Testing Core Contracts

Tests are colocated as `*.test.ts` beside parser, generator, rules, templates,
and subscription modules. Use Vitest `describe`, `it`, and `expect`; tests
should exercise public behavior and canonical output rather than private helper
implementation.

Reference suites:

- `packages/core/src/core-contracts.test.ts` for stable cross-module contracts.
- `packages/core/src/parser` tests for valid, invalid, and alias input.
- `packages/core/src/generator` tests for rule ordering and YAML semantics.
- `packages/core/src/templates/config-template.test.ts` for template validation.

Every new protocol or rule behavior needs at least one success case and one
failure or compatibility case. Use `npm run test:core`; use the full
`npm run test:unit` when shared consumers may be affected.
