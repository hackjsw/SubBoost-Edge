# @subboost/core Backend Guidelines

`packages/core` is the dependency-light domain library used by browser, Node,
and Worker code. It parses proxy formats and generates Clash/Mihomo data, but
does not own HTTP routes, persistence, authentication, or scheduled jobs.

## Guidelines

- [Domain pipeline](./domain-pipeline.md)
- [Testing](./testing.md)

## Pre-Development Checklist

- Identify the exported subpath in `packages/core/package.json`.
- Read the canonical type and the parser/generator tests for the changed
  protocol or rule feature.
- Check browser compatibility before adding any dependency or platform API.

## Quality Check

- Run `npm run test:core` for core-only changes.
- Run `npm run test:unit` when an exported contract changes.
- Confirm parsing failures remain represented in the existing result/error
  shape and that no persistence or transport code entered this package.
