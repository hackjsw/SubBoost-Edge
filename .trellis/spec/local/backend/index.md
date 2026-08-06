# @subboost/local Backend Guidelines

Local backend code is implemented with Next.js route handlers, Prisma/Postgres,
encrypted secrets, and Node-side subscription services.

## Guidelines

- [API and authentication](./api-and-auth.md)
- [Persistence and services](./persistence-and-services.md)
- [Testing](./testing.md)

## Pre-Development Checklist

- Trace route -> handler -> service -> Prisma for the changed operation.
- Read the shared server-core result/error contract and the matching Edge API.
- Check authentication, ownership, encryption, and SSRF boundaries.

## Quality Check

- Run the focused route/service tests and `npm run local:typecheck`.
- Run `npm run local:build` for route or Prisma contract changes.
- Verify every protected record operation scopes data to the current admin.
