# @subboost/local Frontend Guidelines

The Local Next.js app is a thin runtime adapter around shared UI surfaces.
Application-specific client components live under `local/src/components`.

## Guidelines

- [Application adapters](./app-adapters.md)
- [Client components](./client-components.md)
- [Testing](./testing.md)

## Pre-Development Checklist

- Read the shared surface adapter type and the corresponding Edge adapter.
- Reuse shared components and stores before creating Local-only UI state.
- Keep server-only modules out of client files.

## Quality Check

- Run relevant Local page/route tests and `npm run local:lint`.
- Run `npm run local:typecheck` for adapter contract changes.
- Verify shared-surface behavior remains equivalent across runtimes unless the
  capability is intentionally Local-only.
