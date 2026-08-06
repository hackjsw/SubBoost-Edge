# @subboost/server-core Consumer Guidelines

Frontend packages consume server-core DTO and error contracts; they do not
import server orchestration or Node-only crypto/security modules.

## Guidelines

- [Consumer contracts](./consumer-contracts.md)
- [Backend service contracts](../backend/service-contracts.md)

## Pre-Development Checklist

- Read the API response type and the component/adapter that consumes it.
- Confirm the imported subpath is browser-safe.

## Quality Check

- Test success, partial failure, and unavailable states in the consuming UI.
- Verify raw payload fields are decoded once at the adapter boundary.
