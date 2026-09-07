# Execution plan

1. **Baseline and planning gate**
   - Preserve the current dirty worktree; record affected files and run the existing checks.
   - Read package specs for edge, local, server-core, core, and UI before each seam.

2. **Cloudflare build hardening**
   - Replace recursive archive discovery with a tracked/allowlisted manifest and metadata/hash tests.
   - Keep the Edge build and CI checks reproducible without changing the Local/Docker deployment.

3. **Edge/server hardening**
   - Finish generation-safe stored-config cache and remove unsafe bypass/buffering behavior.
   - Add import total deadlines, request/concurrency budgets, deduplication, payload sniffing, streaming size enforcement, DNS/rebinding checks, and auth/rate-limit/KV race protections.
   - Add focused regression tests before changing behavior.

4. **UI/parser hardening**
   - Apply semantic/accessibility fixes, effect cleanup, and bounded rendering.
   - Precompile/lazy-load parser generation and measure bundle/runtime impact.

5. **Quality gate**
   - Run targeted tests after each seam, then full lint/unit/typecheck/build/archive/Docker smoke checks.
   - Review all changed files against acceptance criteria and update specs with durable lessons.
   - Record deferred lower-priority findings and prepare logical commits; do not push.

   **Scope decision for this subscription-converter audit**
   - Keep only fixes with a direct effect on trust boundaries, data consistency,
     basic runtime availability, or release reproducibility.
   - Defer full DNS rebinding/socket pinning, cross-instance authentication
     rate-limit CAS, a full parser lazy-split/precompile redesign, and same-URL
     GET/HEAD request coalescing. These need broader operational or performance
     work than this project currently justifies.
   - Do not force the proposed Prisma major downgrade (`6.19.3`) without a
     compatibility test; the existing audit finding remains open.
   - Docker, Local deployment, and container smoke checks are outside this pass.

## Rollback points

- After archive/release changes (tooling-only).
- After Edge/server changes (runtime security boundary).
- After UI/parser changes (delivery/performance).

## Validation commands

```text
npm run lint
npm run test:unit
npm run edge:typecheck
npm run check:local-app
npm run edge:build
node edge/scripts/build-source-archive.mjs --help
npm run edge:build
```
