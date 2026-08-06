# Browser Contracts

Use core as the typed domain boundary beneath React:

- `GenerateOptions` and generator results are the input/output contract for UI
  generation flows.
- `GeneratedRuleEntry` carries rule metadata required by rule editors.
- `ParsedNode` and `ParseResult` are the canonical parser contracts.
- Template metadata and `validateTemplateConfig` come from
  `packages/core/src/templates/index.ts`.
- Node naming and identity helpers should be reused rather than reimplemented
  in components.

Import from explicit exported subpaths listed in `packages/core/package.json`.
Avoid Node globals, direct DOM access, React state, network requests, or storage
inside core modules. Those concerns belong to `packages/ui` or an application
adapter.
