# Add Edge rule sync status

## Goal

Make the existing automatic rule catalog synchronization visible and
controllable from the authenticated EdgeSub dashboard, so an administrator can
tell whether remote rules are current and can request an immediate refresh.

## Confirmed Facts

- The deployed site is `https://sub.cces.us.ci/`.
- Saved subscriptions are scanned every 15 minutes, but the remote rule catalog
  has its own daily `17 3 * * *` UTC cron.
- The rule catalog is stored under the versioned KV key
  `edge-rule-index:v1` and has a 24-hour freshness window.
- Rule search already falls back to stale KV data and then the bundled catalog.
- Dashboard and rule APIs require the existing signed admin session.

## Requirements

- Add authenticated `GET /api/rules/status` without making an upstream request.
- Return the active source, upstream identity, geosite/geoip/total counts, last
  fetch time, cache expiry, cron expression, and next scheduled daily run.
- Add authenticated `POST /api/rules/refresh` that reuses the forced rule
  catalog refresh used by the daily cron.
- Preserve a usable stale or bundled catalog when the upstream refresh fails.
- Add a compact light-theme dashboard status panel with a manual refresh button,
  stable loading/error states, and success/warning/error feedback.
- Disable the manual button while a refresh is in progress.
- Keep the 15-minute subscription cron and daily rule cron frequencies
  unchanged.
- Update the documented deployment URL and API list.

## Acceptance Criteria

- [ ] Anonymous status and refresh requests return 401.
- [ ] Unsupported methods return 405 with the correct `Allow` header.
- [ ] Status reads valid KV data and reports exact rule counts and timestamps
  without calling GitHub.
- [ ] Missing/invalid rule KV data reports the bundled fallback accurately.
- [ ] Manual refresh reports refreshed, stale, and unavailable outcomes without
  deleting the previous usable index.
- [ ] Dashboard renders source, counts, last sync, next sync, loading, error,
  and refreshing states without layout overlap on desktop or mobile.
- [ ] Worker and component tests pass, and Edge lint/type-check/build pass.
- [ ] README points to `https://sub.cces.us.ci/` and documents both endpoints.
- [ ] Changes are committed, pushed to `hackjsw/SubBoost-Edge`, deployed, and
  the production health/status flow is verified.

## Out Of Scope

- Synchronizing SubBoost configuration templates. This feature exposes the
  MetaCubeX rule catalog sync that already exists.
- Increasing cron frequency or adding a distributed KV lock.
- Adding Local/Postgres equivalents of the Edge operational panel.
