# Components

Primitive components under `packages/ui/src/components/ui` are client modules
built from Radix primitives, `React.forwardRef`, and the shared `cn` helper in
`packages/ui/src/lib/utils.ts`. Preserve native/Radix semantics and forward
refs when wrapping an interactive primitive.

Feature surfaces receive typed adapter objects. For example,
`TemplateLibrarySurface` requires load methods and exposes optional mutation
capabilities. Render controls only when the capability exists; do not make an
Edge deployment pretend to support a Local-only operation.

Use Lucide icons already present in the package for button actions, with an
accessible label or visible text. Use `toast` for command outcomes and the
shared confirm-dialog host for destructive confirmation. Keep compact product
screens aligned with the existing light workbench visual system.

Avoid nesting decorative cards, adding runtime-specific fetch logic to a
shared surface, or duplicating primitive styling. Large surfaces may coordinate
their own local loading state, but transport stays behind the adapter.
