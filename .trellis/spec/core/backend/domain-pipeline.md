# Domain Pipeline

## Canonical Data

Protocol parsers normalize input into the `ParsedNode` union in
`packages/core/src/types/node.ts`. Extend that union and its protocol tests
before teaching downstream generators about a new protocol. Parser boundaries
return `ParseResult` with `nodes`, `errors`, `totalParsed`, and `totalFailed`;
do not make callers infer partial failure from thrown exceptions.

Platform parser examples live under
`packages/core/src/parser/platform/parse-platform-proxy-line.ts`. They try the
supported grammars, normalize aliases in place, validate required core fields,
and return `null` when a line is not recognized. User-facing parser errors are
short and actionable; preserve the existing Chinese messages where that is the
surrounding convention.

## Generation And Rules

`packages/core/src/generator/index.ts` is a pure generation boundary. Its
`GenerateOptions` receives parsed nodes, templates, groups, rule modules, and
overrides, then returns generated configuration without doing I/O.

Rule assembly uses typed records such as `GeneratedRuleEntry` in
`packages/core/src/generator/rules.ts`. Preserve discriminants (`kind`) and
metadata used by the UI (`sourceLabel`, `summary`, `target`, `editable`, and
`enabled`) instead of passing untyped YAML fragments between layers.

Template definitions in `packages/core/src/templates/index.ts` are compile-time
presets. `getTemplate` deliberately falls back to `standard`; validation
returns `{ valid, errors }`. Remote template synchronization is not currently
part of this package.

## Errors And Boundaries

- Prefer explicit result objects for recoverable input failures. See
  `packages/core/src/json.ts` and `ParseResult`.
- Throw typed errors only when generation cannot produce a valid result. See
  `BaseConfigYamlError` in `packages/core/src/generator/index.ts`.
- Do not import Next.js, Prisma, Cloudflare Worker APIs, or Node-only modules.
- Keep transport, authentication, cache, and persistence in `server-core`,
  `local`, or `edge`.
