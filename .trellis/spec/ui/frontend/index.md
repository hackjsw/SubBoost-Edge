# @subboost/ui Frontend Guidelines

`packages/ui` owns the shared React product surfaces, primitives, stores, and
runtime adapter seams used by both `local` and `edge`.

## Guidelines

- [Components](./component-guidelines.md)
- [State management](./state-management.md)
- [Adapters and data](./adapters-and-data.md)
- [Testing](./testing.md)

## Pre-Development Checklist

- Read the surface adapter and both application page adapters.
- Reuse an existing primitive, icon, toast, and response helper before adding
  another pattern.
- Decide whether state is local UI state, persisted user config, or server data.

## Quality Check

- Run the affected `packages/ui/src/**/*.test.ts` tests.
- Run `npm run lint` and `npm run edge:typecheck` for shared surface changes.
- Verify keyboard labels, loading, empty, error, and disabled states.
- Confirm both `local` and `edge` adapters still type-check.
