# Security And Runtime Adapters

Remote fetch code must retain the existing defense layers: public URL checks,
private/reserved IP rejection, redirect limits, response size limits, timeouts,
and sanitized public failure reasons.

Shared IP classification lives in
`packages/server-core/src/subscription/ssrf-ip.ts`. Local adds DNS/DoH checks in
`local/src/lib/source-import.ts`; Edge implements Worker fetch limits in
`edge/worker/remote-fetch.ts`. Do not weaken one runtime while changing the
other.

Most subscription orchestration is runtime-neutral, but these submodules are
explicitly Node-only:

- `packages/server-core/src/crypto/encrypted-field.ts` uses `node:crypto` and
  `Buffer`.
- `packages/server-core/src/subscription/ssrf-ip.ts` uses `node:net` for IP
  parsing.

Do not import Node-only subpaths into Cloudflare Worker code. Keep tokens,
passwords, source URLs, encrypted values, and subscription bodies out of logs.
