# Execute comprehensive optimization and security audit

## Goal

Reduce the highest-risk production, security, reliability, and accessibility issues found in the repository audit while preserving the user's existing worktree changes. The result must be reproducible from the lockfile, bounded against untrusted input, and covered by regression tests.

## Background and confirmed facts

- The repository contains Edge, local, shared core/server-core, and UI packages. Existing worktree changes add source-import heuristics, stored-config caching, parser behavior, and subscription failure metadata; those changes are in scope and must not be reverted.
- Baseline checks currently pass: `npm run lint`, `npm run test:unit`, `npm run edge:typecheck`, `npm run check:local-app`, and `npm run edge:build`.
- The source archive builder recursively walks the worktree and currently includes private/ignored paths (`.trellis`, `.agents`, `.codex`, generated output, and untracked files).
- The Edge stored-config cache can be bypassed publicly with `force=1`; invalidation must account for in-flight reads. Remote imports and refreshes need a total request budget, bounded concurrency, and streaming byte limits.
- The local Docker/release path does not reliably install the tested lockfile, runs as root, and can move release pointers before assets are ready. Release asset cleanup accepts path traversal/root-like output values.
- Subscription credentials and remote fetches cross trust boundaries. Auth/rate limits, DNS/rebinding checks, KV write races, and UI form/button semantics need hardening.

## Requirements

1. **Release boundary and supply chain**
   - Build Edge source archives only from an explicit product-source allowlist (or Git-tracked manifest), never private/ignored/generated paths; include the source commit/dirty state and archive digest in metadata and add a regression smoke test.
   - Make Docker builds consume the repository lockfile reproducibly, retain only production dependencies in the runtime image, run as a non-root user with signal-correct startup and health checks, and make release publication/pointer movement happen only after all checks and assets succeed.
   - Reject release-asset output paths that resolve outside the intended distribution directory; use recoverable temporary output and test `.`/`..`/absolute/traversal inputs.
   - Upgrade direct vulnerable dependencies to available compatible patches, regenerate the lockfile against the official npm registry, and add a repeatable audit/check command without forcing a breaking major downgrade.

2. **Edge and server security/reliability**
   - Make stored-config cache entries generation/version aware so stale in-flight reads cannot repopulate after PUT/PATCH/DELETE; remove or authenticate cache bypasses and avoid buffering bodies that cannot be cached.
   - Enforce total deadlines and a bounded attempt/subrequest budget for source import and scheduled refresh; deduplicate supplemental user-info requests, sniff payloads when content types are misleading, and stream/cancel oversized remote bodies.
   - Bound concurrent remote fetches, harden local DNS/rebinding validation, and make auth/rate limiting and KV persistence safe under concurrent requests.
   - Prevent persistent bearer-token leakage to the default converter endpoint; require explicit opt-in/self-host configuration and short-lived capability forwarding.

3. **UI and runtime quality**
   - Fix mobile menu and subscription controls for keyboard/screen-reader semantics, labels, contrast, and touch targets; add request/timer cleanup and avoid unbounded subscription rendering.
   - Precompile Peggy grammars or otherwise keep the parser generator out of the runtime bundle, lazy-load the advanced converter path, and move expensive generation work off the input path where feasible.
   - Remove or document dead/duplicated UI code only where tests prove no production caller; do not expand scope into unrelated redesign.

4. **Verification and documentation**
   - Add regression tests for each changed security boundary and run the full affected-package quality checks, including archive/release/Docker smoke tests where the host supports them.
   - Update applicable Trellis specs with durable lessons and clearly mark any deliberately deferred audit findings.

## Acceptance criteria

- [ ] Existing baseline tests remain green and new regression tests cover archive allowlisting/metadata, cache invalidation and bypass policy, import deadlines/limits, release path validation, and changed UI semantics.
- [ ] A fresh Edge archive contains only allowlisted product files and records the source revision, dirty state, and deterministic SHA-256; no `.trellis`, `.agents`, `.codex`, generated, or arbitrary untracked paths are present.
- [ ] Production Docker/release instructions use the tested lockfile, least privilege, deterministic startup, and post-check publication ordering; unsafe output paths fail closed.
- [ ] Remote input handling has explicit byte, time, concurrency, and auth/rate limits with no known stale-cache or credential-forwarding regression.
- [ ] `npm run lint`, `npm run test:unit`, `npm run edge:typecheck`, `npm run check:local-app`, `npm run edge:build`, and targeted new smoke checks pass (or an environment limitation is recorded).
- [ ] Remaining lower-priority audit items are listed in the implementation/task notes rather than silently implied as complete.

## Out of scope

- Product redesign, API-breaking schema migrations, replacing KV with a new persistence service, or broad dependency-major upgrades without a migration plan.
- Removing unrelated user worktree changes or fixing every pre-existing TypeScript fixture error in one pass.
