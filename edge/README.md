# EdgeSub

EdgeSub combines the SubBoost converter UI with Cloudflare subscription Worker contracts.

## Architecture

- `app/` statically exports the SubBoost conversion workspace.
- `worker/` serves the static export through Workers Static Assets.
- `/sub`, `/clash`, `/shorten`, and `/test` retain the existing Worker API surface.
- `/api/source-import` proxies remote subscription content for the browser-side SubBoost parser.
- `/api/subscriptions` and `/config/:token` persist generated YAML, sources and refresh settings in the per-token `SUB_STORE` SQLite Durable Object. `SUB_KV` remains the discovery index and compatibility mirror.
- `/dashboard` lists the authenticated administrator's subscriptions and supports editing, refreshing, downloading, and deleting them.
- `/login` uses a Worker Secret password and a signed HttpOnly session cookie; management and conversion endpoints require authentication.
- A Cloudflare Cron trigger runs every 15 minutes and refreshes subscriptions whose configured interval has elapsed.
- Failed refreshes keep serving the last successful YAML and retry after one hour.
- Legacy rolling seven-day YAML records are migrated to persistent records the next time their config URL is accessed.
- `/subboost-edge-source.tar.gz` serves the complete corresponding source generated from the current worktree.

## Commands

```bash
npm run edge:typecheck
npm run edge:build
npm run edge:deploy
```

The deployment config targets the existing `test` Worker and its `SUB_KV` namespace. Verify the Cloudflare account before deploying.

The `v1-subscription-store` migration adds `SubscriptionStore`. Existing KV records are imported on first access without changing their URLs. Pending KV mirrors retry through a durable alarm, so list/Cron discovery can briefly lag behind a successful write. Keep the Durable Object binding and authoritative reads when rolling back; a KV-only version may serve stale data.

Configure the two required secrets before deployment:

```bash
npx wrangler secret put EDGE_ADMIN_PASSWORD --config edge/wrangler.jsonc
npx wrangler secret put EDGE_SESSION_SECRET --config edge/wrangler.jsonc
```

Public Clash config URLs remain bearer links so subscription clients do not need the web login password.

## Output formats

- `/config/:token` and `?format=clash` keep the existing Clash/Mihomo YAML behavior, including the saved conversion profile and `raw=1` option.
- `/config/:token?format=v2rayn` exports the saved YAML's compatible nodes as a UTF-8 Base64 subscription. It does not call a subconverter or change the stored record/token. This explicit format also takes precedence over `raw=1`.
- Format is never inferred from User-Agent. The response cache separates formats and GET/HEAD; writes invalidate every variant for the token. Subscription mutations are serialized by a per-token Durable Object, while KV remains the compatibility mirror.
- The home download controls, generated-link dialog and dashboard expose both formats. Existing `/sub?id=...` and `/clash?id=...` GET links retain their behavior. POST conversion requires login even if the URL contains a short-link ID.
- v2rayN export supports common SS, VMess, VLESS, Trojan, Hysteria2, TUIC v5 and AnyTLS nodes. Clash routing/DNS/groups/listeners/providers are not included. Unsupported nodes and nodes requiring a dialer proxy are skipped; advanced client options are not guaranteed to be equivalent. A snapshot without exportable nodes returns HTTP 422.
- Responses expose `X-SubBoost-Node-Count`, `X-SubBoost-Skipped-Nodes` and `X-SubBoost-Skipped-Providers`, while keeping the subscription name, userinfo and update interval headers.
- New saves validate YAML structure, common node requirements, provider definitions, node limits and proxy references. Structured saves regenerate YAML from nodes/config using the refresh generator; empty structured snapshots without providers are rejected. Valid YAML-only snapshots are preserved verbatim, including explicit direct-only configurations. Existing GET snapshots are not regenerated. This is structural validation, not a complete Mihomo engine check.
- Refresh responses expose `X-SubBoost-Stale-Userinfo` when a failed source contributes its last known usage metadata.
- Legacy `/sub` keeps host-port deduplication by default; callers that need distinct credentials on one endpoint can pass `dedup_strategy=identity` (the same option is retained by short links).

The dual-format UI is enabled by the Cloudflare page adapters only.

## License

SubBoost and this network-deployed derivative are licensed under AGPL-3.0-only. `npm run edge:build` creates a source archive before the static export so every deployment can provide its exact modified source from the header, footer, and mobile navigation.
