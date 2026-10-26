<!-- markdownlint-disable MD033 MD041 -->
<div align="center">
  <p><img src="edge/public/edgesub-mark.svg" alt="EdgeSub" width="96"></p>
  <h1>EdgeSub</h1>
  <p>A Cloudflare Workers edition of SubBoost</p>
  <p>
    <a href="https://github.com/hackjsw/SubBoost-Edge"><img src="https://img.shields.io/badge/source-EdgeSub-087f70.svg" alt="Source repository"></a>
    <a href="https://github.com/SubBoost/subboost"><img src="https://img.shields.io/badge/upstream-SubBoost%20v2.10.0-blue.svg" alt="Upstream project"></a>
    <img src="https://img.shields.io/badge/runtime-Cloudflare%20Workers-F38020.svg" alt="Cloudflare Workers">
    <img src="https://img.shields.io/badge/license-AGPL--3.0--only-green.svg" alt="AGPL-3.0-only">
  </p>
  <p><strong><a href="README.md">English</a> | <a href="README-CN.md">中文</a></strong></p>
  <p>
    <a href="https://sub.cces.us.ci/">Live deployment</a> ·
    <a href="https://github.com/SubBoost/subboost">Upstream source</a> ·
    <a href="https://docs.subboost.org">Upstream docs</a>
  </p>
</div>
<!-- markdownlint-enable MD033 MD041 -->

## Overview

EdgeSub runs the SubBoost Clash/Mihomo config generator and subscription manager inside a single Cloudflare Worker. The Next.js frontend is statically exported and served through Workers Static Assets. The API, login, subscription storage, and scheduled refreshes all run in the same Worker, so there is no server or database to maintain.

EdgeSub does not provide proxy nodes or proxy services. It only parses, converts, stores, and refreshes subscription content that you supply.

## Origin and Acknowledgements

EdgeSub is an unofficial modified version of [SubBoost](https://github.com/SubBoost/subboost). It is not an official release from the SubBoost team. The repository keeps the upstream Git history, so the origin of the code and later syncs can be traced.

- **2026-07-21**: Added Cloudflare Workers deployment, login protection, subscription management, scheduled refreshes, and remote rule catalog sync on top of upstream v2.6.0.
- **2026-10-07**: Synced the parsing, refresh, and configuration features of upstream v2.9.0.
- **2026-10-26**: Synced the protocol-option and rule-target fixes from upstream v2.10.0.

EdgeSub has always kept its own interface design.

Special thanks to the original author and lead maintainer [RyanVan (@Ryson-32)](https://github.com/Ryson-32), the [SubBoost team](https://github.com/SubBoost), and all [contributors](https://github.com/SubBoost/subboost/graphs/contributors) for their work on subscription conversion, node parsing, rule management, and the visual editor. This Edge edition would not exist without them.

Thanks also to these projects and communities:

- [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat): remote rule catalog and rule-set data.
- [ACL4SSR/ACL4SSR](https://github.com/ACL4SSR/ACL4SSR): Clash conversion rule profiles.
- [Cloudflare Workers](https://workers.cloudflare.com/): edge runtime, KV, Durable Objects, Cron Triggers, and static asset hosting.
- Members and users of the LINUX DO, IDC Flare, and SubBoost communities.

Copyright in the original project and existing code belongs to its authors and contributors. Changes in this repository remain under `AGPL-3.0-only`.

## Features

- **Config generation**: Keeps SubBoost's Clash/Mihomo config generation, node import, proxy chains, and fine-grained routing.
- **Three-step generator**: Subscription sources → rule scheme → save.
  - **Sources**: Pasted input is recognized as a subscription URL, Clash YAML, or node links. You can also drop in a `.yaml` file.
  - **Rule scheme**: Choose the built-in rules or one of 7 ACL4SSR online profiles. Turn on "Customize" to adjust nodes, relay groups, routing groups, rules, and DNS.
- **Two output formats**: Clash / Mihomo YAML and v2rayN Base64. See [Output Formats](#output-formats).
- **My subscriptions** (`/dashboard`):
  - Shows each subscription's refresh status, node count, traffic used, and expiry.
  - Supports filtering, search, link copying, QR codes, editing, refreshing, downloading, and deleting.
  - Failed refreshes show the reason and a retry button.
- **Scheduled refresh**: Every 6 hours, due subscriptions are refreshed, each in its own invocation. A failed refresh keeps serving the last successful config and retries after one hour.
- **Rule catalog**: The MetaCubeX rule catalog syncs daily, and search results are cached for 24 hours. When the GitHub API is rate-limited, it falls back to the official catalog page, then to a bundled catalog.
- **Login protection**:
  - Management and conversion endpoints require login. The password is a Worker Secret, and sessions use a signed HttpOnly cookie.
  - `/config/:token` links act as bearer links, so subscription clients do not need to log in.
- **Themes**: System, light, and dark modes. The accent color can be one of 8 presets or any custom color.
- **Legacy endpoints**: The original Worker's `/sub`, `/clash`, `/shorten`, and `/test` endpoints are kept.
- **Source availability**: The build generates the matching source archive, served at `/subboost-edge-source.tar.gz`.

## Output Formats

| Format | Example link | Content |
| --- | --- | --- |
| Clash / Mihomo | `/config/<token>` | Full YAML, including the selected rule scheme |
| v2rayN | `/config/<token>?format=v2rayn` | Nodes from the last successful save or refresh, UTF-8 Base64 |

- **Choosing a format**: Append `&format=v2rayn` if the link already has query parameters. You don't need to recreate the subscription or change its token. The default format never depends on the client's User-Agent.
- **What v2rayN export covers**:
  - Protocols: common options for SS, VMess, VLESS, Trojan, Hysteria2, TUIC v5, and AnyTLS.
  - Transports: TCP, WebSocket, HTTPUpgrade, gRPC, and XHTTP, where they can be expressed.
  - Not included: Clash routing, DNS, proxy groups, listeners, and proxy providers.
- **Skipped nodes**: Nodes that need `dialer-proxy`, or use unsupported protocols, plugins, or transport options, are skipped. Downloads show how many were skipped. If nothing can be exported, the response is HTTP 422.
- **Caching**: v2rayN output is generated by built-in code in the browser or Worker, not by an external subconverter. The edge cache keeps the two formats separate, and editing, refreshing, or deleting a subscription invalidates both.

## Storage

- **`SUB_STORE`** (SQLite Durable Object): One instance per subscription. It stores the generated YAML, sources, and refresh settings, and is the authoritative copy. Writes to the same subscription are serialized here.
- **`SUB_KV`**: The discovery index and compatibility mirror, used by the subscription list and the Cron scan. It also caches the rule catalog.
- **Migration**: Legacy KV records are imported into the Durable Object on first access. Subscription URLs stay the same.
- **Mirror lag**: Failed KV mirror writes are retried by a Durable Object alarm, so the list and Cron discovery can briefly lag behind a successful write.

## ACL4SSR Online Profiles

The rule scheme step offers 7 official ACL4SSR remote profiles: Standard, Lite, Full, AI, Multi-region, No speed test, and No ad blocking.

- **Where the profile is applied**: The selected profile is saved with the subscription. When the subscription link is fetched, the Worker passes the matching ACL4SSR `master` profile to a subconverter. Cron only refreshes the sources and never copies profile files.
- **Conversion cache**: Results are cached at the Cloudflare edge per subscription and content version. Cached results are served for 30 minutes, so profile updates usually take effect within about 30 minutes. The edge cache only works on custom domains; on `*.workers.dev`, every request is converted again.
- **Backends**: Set `SUBCONVERTER_BACKEND` and `SUBCONVERTER_FALLBACK_BACKENDS` (comma-separated) in `edge/wrangler.jsonc`. The defaults are public backends listed by the [ACL4SSR online tool](https://acl4ssr-sub.github.io/).
  - Each backend gets up to 8 seconds. Timeouts and invalid results switch to the next backend.
  - A failed backend is skipped for 60 seconds.
- **When every backend fails**:
  - The Worker first serves the last successful result for the same version. These results are kept for 7 days, and the response carries `X-SubBoost-Converter-Cache: stale`.
  - If there is none, it serves a native config built with the built-in rules, marked with `X-SubBoost-Converter-Fallback: native`.
- **Privacy**: The converter only receives node names and placeholder nodes, through a temporary link valid for 5 minutes. The Worker fills real addresses, credentials, and VLESS/XHTTP/ECH fields back in.

Public backends may be rate-limited or shut down. You can replace them with your own.

## Deployment

### 1. Requirements

- Node.js `22.13+` or `24+`
- A Cloudflare account with Wrangler logged in
- A KV namespace to bind as `SUB_KV`

```bash
npm ci
```

### 2. Configure the Worker

Create the KV namespace:

```bash
npx wrangler kv namespace create SUB_KV --config edge/wrangler.jsonc
```

Then edit [`edge/wrangler.jsonc`](./edge/wrangler.jsonc):

- Set the `id` under `kv_namespaces` to the namespace ID returned above.
- Change the Worker `name` to your own.
- Change the `service` of the `SELF` binding under `services` to the same name. The Worker uses this binding to call itself, so each subscription's scheduled refresh runs in its own invocation.

Do not reuse the KV ID or Worker name from this repository.

Cron Triggers run in UTC:

| Cron | Purpose |
| --- | --- |
| `0 */6 * * *` | Checks for subscriptions due for refresh, at most 30 per run with the most overdue first. Each one refreshes in its own invocation through the `SELF` binding. Intervals shorter than 6 hours effectively run every 6 hours |
| `17 3 * * *` | Syncs the remote rule catalog once a day |

### 3. Configure Secrets

The login password and the session signing key must be stored as Worker Secrets, never in source:

```bash
npx wrangler secret put EDGE_ADMIN_PASSWORD --config edge/wrangler.jsonc
npx wrangler secret put EDGE_SESSION_SECRET --config edge/wrangler.jsonc
```

If you search rules often, you can add a read-only GitHub token for a higher API rate limit:

```bash
npx wrangler secret put GITHUB_TOKEN --config edge/wrangler.jsonc
```

### 4. Check and Deploy

```bash
npm run edge:typecheck
npm run edge:build
npm run edge:deploy
```

Bind a custom domain under Worker Routes or Custom Domains in the Cloudflare dashboard. Secrets and KV data are never included in the Git repository or the source archive.

## Endpoints

| Path | Description |
| --- | --- |
| `/` | Config generator |
| `/login` | Administrator login |
| `/dashboard` | My subscriptions |
| `/config/:token` | Permanent link to a saved subscription; no login required |
| `/api/subscriptions` | Subscription management; login required |
| `/api/source-import` | Fetches remote subscription content for the browser; login required |
| `/api/rules/search` | Remote rule catalog search; login required |
| `/api/rules/cn-candidates` | China rule candidates; login required |
| `/api/rules/status` | Rule catalog cache and next sync time; login required |
| `/api/rules/refresh` | Syncs the rule catalog now; logged-in POST only |
| `/api/health` | Health check |
| `/sub` | Generic Base64 subscription output (legacy) |
| `/clash` | Clash YAML conversion output (legacy) |

## Repository Layout

| Directory | Purpose |
| --- | --- |
| `edge/app` | Edge Next.js pages: generator, login, and my subscriptions |
| `edge/src` | Edge page components, themes, and layout |
| `edge/worker` | Worker routing, login, Durable Object, KV, conversion, rule API, and Cron |
| `packages/core` | Upstream protocol parsing, config generation, and rule models |
| `packages/server-core` | Upstream server-side subscription handling and rule catalog |
| `packages/ui` | Upstream SubBoost configurator and shared UI |
| `local` | Upstream self-hosted edition (Node.js + PostgreSQL) |
| `docs/design/edge-ui-v2` | EdgeSub UI design files |

## Local Development

```bash
npm run edge:dev
npm run edge:typecheck
npm run test:unit
npm run lint
```

- **Local secrets**: See [`edge/.dev.vars.example`](./edge/.dev.vars.example). The real `edge/.dev.vars` is ignored by Git.
- **Root type check**: `npx tsc --noEmit -p tsconfig.json` also covers `local/`. Generate the Prisma client first:

  ```bash
  npm run local:db:generate
  ```

- **Tests on Windows**: The workerd-based Durable Object runtime tests are skipped by default. Set `EDGESUB_RUN_WORKERD_TESTS=1` to run them anyway.

## Syncing Upstream

```bash
git remote add upstream https://github.com/SubBoost/subboost.git
git fetch upstream
```

EdgeSub's shared packages have diverged from upstream, so a plain merge usually doesn't work; cherry-pick individual commits instead. When you do:

- Keep the `edge/` directory and the EdgeSub UI.
- Upstream's `test/regression/` is removed in this repository. Resolve those conflicts by keeping the files deleted.
- Since v2.10.0, upstream uses `js-yaml` 5.x and adds `packages/core/src/config/yaml-schema.ts`. This repository still uses 4.3.2, so commits that depend on that file must be synced together with the dependency upgrade.
- After syncing, run `npm run test:unit`, `npm run edge:typecheck`, and `npm run edge:build`.

## Changelog

### Unreleased (main, 2026-10-26)

This update syncs the upstream SubBoost v2.10.0 fixes that directly affect subscription conversion, and clears the root type-check errors. The UI is unchanged.

- **Protocol options are preserved on import**. These advanced options need support from the client kernel.
  - VLESS XHTTP: independent download settings (`download-settings`), connection reuse, and padding options.
  - VLESS Reality: hybrid key exchange (`support-x25519mlkem768`).
  - Hysteria2: ECH, TCP Fast Open, and obfuscation packet sizes.
  - TUIC/Hysteria, WireGuard, Snell (including `shadow-tls`), and SSH: some parameters that were previously lost or mapped incorrectly.
- **Rule targets**: Fixed target proxy-group matching after rule imports, and stale rule references after a group is renamed, disabled, or deleted. The editor and the graph preview now agree.
- **YAML compatibility**: The upstream fixes target `js-yaml` 5.x. The 4.3.2 version used by EdgeSub already handles the cases they restore, so the new upstream YAML module was not brought in. The matching regression tests were kept. The cases are:
  - passwords such as `+.5`;
  - indentation in multi-line flow arrays;
  - `yes` staying a string instead of becoming a boolean.
- **Upstream changes not adopted**:
  - The SSRF re-check for IPv6 fake-IP DNS environments. It applies to self-hosted servers, and the Worker uses its own remote fetch logic.
  - The dependency and Node.js 24 security baseline upgrade, which mainly targets the Docker images.
- **Type checking**: Root `tsc` errors went from 101 to 0.
  - The root `tsconfig.json` gained the `@local/*` path alias.
  - The route tests now use `NextRequest`.
  - Missing fields were added to test fixtures.

Upgrade notes: Redeploy the Worker. No data migration is needed.

### EdgeSub 2.6.0-edge.13 (2026-10-08)

This release lets custom accents be light colors, and tints the page neutrals with the accent.

- **Light accents work**: The previous release darkened bright colors to keep white button text readable, which turned pink into taupe and light green into dark green. Buttons now use exactly the color you pick. The button text switches between white and near-black based on the fill's luminance, and every color has at least one text color that meets WCAG AA.
- **Visible borders**: Borders and tinted backgrounds are visible again with light accents. Previously `#ffc0cb` produced a `#ffedf0` border. Custom scales are now derived from absolute lightness.
- **Accent-tinted neutrals**: Backgrounds, cards, and dividers keep their lightness steps but take on the accent's hue. This also applies to shared SubBoost component areas. Body text tinting is unchanged.
- **Compatibility**: The tinting uses CSS relative color syntax (Chrome 119+, Safari 16.4+, Firefox 128+). Older browsers fall back to the previous neutral palette.
- **Known trade-off**: A very dark custom accent in the dark theme makes button outlines faint, though the button text stays readable.

Upgrade notes: Redeploy the Worker. No data migration is needed. Previously chosen custom colors return to the exact color originally picked.

### EdgeSub 2.6.0-edge.12 (2026-10-08)

This release makes the theme accent customizable and unifies contrast across accents.

- **Theme menu**: The header theme button is now a menu with System, Light, and Dark. Accents come in 8 presets (orange, amber, rose, purple, indigo, blue, cyan, green), or you can pick any color.
- **Local storage**: The choice is stored only in the browser and applied before first paint, so there is no flash.
- **Applied everywhere**: The accent also applies to upstream SubBoost component areas. The whole palette is driven by one 11-step scale.
- **Contrast**: All 8 presets meet WCAG AA (4.70:1 to 6.29:1). As a result the default orange is darker; light-theme buttons changed from `#ea580c` to `#c2410c`.

Upgrade notes: Redeploy the Worker. No data migration is needed.

### EdgeSub 2.6.0-edge.11 (2026-10-07)

This release syncs node parsing, subscription refresh, and configuration features from upstream SubBoost v2.9.0, keeping the EdgeSub UI.

- **Renamed nodes**: Fixed relay groups breaking after a provider renames nodes. Refreshes now carry renames through to relay and exit nodes, listeners, and group member order.
- **REALITY nodes**: Fixed REALITY nodes being treated as new on every refresh and appended again. Manual renames also survive provider renames.
- **Parsing fixes**:
  - Shadowrocket VLESS links are no longer mistaken for REALITY.
  - Certificate fingerprints are no longer read as client fingerprints, and `tfo` is kept.
  - Numeric passwords keep their leading zeros, and WireGuard, Mieru, and similar nodes are no longer dropped.
  - Rules with special characters produce valid YAML.
  - IPv6, SSR node names, and millisecond expiry times parse correctly.
- **Automatic node processing**: Added "Node management → Automatic processing", which keeps or excludes nodes by original name with a regex. It also applies during scheduled refreshes. Risky patterns are rejected to stay within Workers CPU limits.
- **Proxy-group advanced settings**: You can change a group's type and bind a local listener port. Auto speed-test groups can use their own test URL.
- **Custom rules**: Accept `.mrs` rule-set links, including bulk import.
- **Upstream changes not adopted**:
  - The new upstream theme.
  - Fetching subscriptions once per client identifier, which would double subrequests on Workers.
  - Cron authentication that depends on `node:crypto`.

Upgrade notes: Redeploy the Worker. No data migration is needed.

### Earlier Releases

| Version | Date | Highlights |
| --- | --- | --- |
| 2.6.0-edge.10 | 2026-10-05 | Newly pasted nodes no longer hidden by stale deletions; every successful save is confirmed |
| 2.6.0-edge.9 | 2026-10-05 | Deleting one of several same-named nodes no longer hides the rest; customize panel opens when editing |
| 2.6.0-edge.8 | 2026-10-05 | Fixed nodes and sources occasionally lost when editing from My subscriptions |
| 2.6.0-edge.7 | 2026-10-02 | Full UI redesign: graphite/light themes, three-step generator, YAML and graph drawers, new dashboard, mobile layout |
| 2.6.0-edge.6 | 2026-10-01 | Fits the free plan's 10 ms CPU limit: per-subscription refresh invocations; ACL4SSR edge cache and fallbacks; ETag/304 on `/config` |
| 2.6.0-edge.5 | 2026-10-01 | Fixed overwrites and data loss while editing; next refresh time and failure reasons shown; minimum interval set to 6 hours |
| 2.6.0-edge.4 | 2026-10-01 | Cron moved to every 6 hours, greatly reducing KV writes |
| 2.6.0-edge.3 | 2026-09-07 | Better node connectivity tests; ACL4SSR profiles keep updating remotely |

See the [business logic review](docs/business-logic-review-2026-09-20.md) (in Chinese) for review, fix, and verification results. Upstream release notes are in [docs/release-notes.md](docs/release-notes.md).

## License

EdgeSub and its upstream code are released under the [GNU Affero General Public License v3.0 only](./LICENSE).

If you modify this project and offer it to users over a network, AGPL-3.0 requires you to provide those users with the complete corresponding source of the deployed version. This project links to the source from the header, footer, and mobile navigation, and `npm run edge:build` generates the source archive before the static export.

Keep the project origin, original copyright notices, license file, and modification notes. Do not describe this modified version as an official SubBoost release.

## Disclaimer

This project does not provide proxy services, nodes, or subscription content, and makes no guarantee about the availability, legality, or safety of third-party subscriptions or rule sources. Users are responsible for checking the laws where they live and for the data they import, their deployment configuration, and how they use it.
