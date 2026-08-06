# Tooling Contracts

## Ownership

`packages/config/package.json` exports only three build-time entry points:
`./postcss`, `./tailwind-preset`, and `./tsconfig/base`. Add a new export only
for configuration that is genuinely shared by more than one workspace.

- `packages/config/tsconfig.base.json` is the TypeScript baseline. It enables
  `strict`, `noEmit`, `isolatedModules`, `moduleResolution: bundler`, and JSX
  preservation.
- `packages/config/postcss.config.mjs` is a plain PostCSS config object.
- `packages/config/tailwind-preset.ts` exports a typed preset with
  `satisfies Partial<Config>`.

Consumers should import the exported subpath instead of copying settings. See
`local/postcss.config.mjs` and `local/tailwind.config.ts`.

## Boundaries

- Domain configuration types belong in `packages/core/src/types` or
  `packages/core/src/config`, not here.
- UI state belongs in `packages/ui/src/store`, not here.
- Do not add React, runtime fetches, or environment-specific secrets.
- The current Tailwind colors and motion tokens describe the existing product;
  changing them is a cross-workspace UI change, not a tooling-only refactor.

This package currently has no direct test suite. Validate changes through the
consumer workspace builds.
