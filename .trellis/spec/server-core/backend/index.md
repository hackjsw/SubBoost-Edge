# @subboost/server-core Backend Guidelines

`packages/server-core` owns reusable server orchestration and contracts shared
by the Node application and Cloudflare Worker. Runtime adapters still own I/O,
persistence, authentication, and HTTP routing.

## Guidelines

- [Service contracts](./service-contracts.md)
- [Security and runtime adapters](./security-and-adapters.md)
- [Testing](./testing.md)

## Pre-Development Checklist

- Identify both `local` and `edge` consumers of the changed contract.
- Keep I/O injectable unless the module is explicitly Node-only.
- Read the result union and failure mapping before adding a branch.

## Quality Check

- Run the affected `packages/server-core/src/**/*.test.ts` tests.
- Run `npm run test:unit` for shared contract changes.
- Verify both application adapters still map all result variants and that no
  secrets or raw subscription content are logged.
