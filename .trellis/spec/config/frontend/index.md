# @subboost/config Guidelines

`packages/config` owns build-time configuration shared by the workspaces. It is
not an application package and contains no React components, hooks, state, or
runtime domain validation.

## Guidelines

- [Tooling contracts](./tooling-contracts.md)

## Pre-Development Checklist

- Read `packages/config/package.json` and the consumer config being changed.
- Keep every public entry point explicit in the package `exports` map.
- Confirm whether the change affects both `local` and `edge` before editing a
  shared preset.

## Quality Check

- Run `npm run lint` for TypeScript preset changes.
- Run the affected workspace build (`npm run edge:build` or
  `npm run local:build`) for PostCSS, Tailwind, or TypeScript config changes.
- Verify no application or domain logic was introduced into this package.
