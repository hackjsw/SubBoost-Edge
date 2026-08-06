# @subboost/ui API Boundary Guidelines

`packages/ui` does not implement a backend. This layer documents the HTTP
contracts its adapters expect from `local` and `edge`.

## Guidelines

- [API adapter contracts](./api-contracts.md)

## Pre-Development Checklist

- Read the adapter type and both runtime endpoints before changing a request or
  response.
- Decide whether the contract belongs in `server-core` instead of UI.

## Quality Check

- Test the adapter with an injected `fetchImpl`.
- Verify both runtime implementations still satisfy the same UI contract.
- Keep persistence, authentication, and HTTP handlers out of this package.
