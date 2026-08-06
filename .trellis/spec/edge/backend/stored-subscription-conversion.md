# Stored Subscription Conversion

## Scenario: Allowlisted Clash conversion profiles

### 1. Scope / Trigger

- Trigger: an Edge KV subscription may keep its public `/config/<token>` URL while switching between the saved EdgeSub YAML and an ACL4SSR-backed subconverter result.
- The profile catalog is a cross-layer contract shared by Core, the shared UI adapter, Edge APIs, KV records, and the public config handler.
- Remote profile updates come from allowlisted ACL4SSR `master` URLs and the existing 300-second converter cache. Do not add a profile-refresh cron.

### 2. Signatures

- `CLASH_CONVERSION_PROFILES`, `ClashConversionProfileId`, `isClashConversionProfileId`, and `resolveClashConversionProfileId` live in `@subboost/core/subscription/clash-conversion-profiles`.
- `POST /api/subscriptions` accepts `conversionProfileId?: ClashConversionProfileId`.
- `PUT /api/subscriptions/<token>` accepts the same optional field; omission preserves the stored profile.
- `GET /api/subscriptions` and `GET /api/subscriptions/<token>` return the normalized `conversionProfileId`.
- `GET|HEAD /config/<token>` returns native or converted YAML. `?raw=1` always returns the stored YAML.
- `/clash?profile=<allowlisted-remote-id>` selects an ACL4SSR profile for the legacy conversion endpoint.

### 3. Contracts

- The serialized KV field `conversionProfileId` remains optional for compatibility; `parseStoredSubscription` normalizes it into the required internal `StoredSubscription` field, so version-1 and earlier version-2 records require no bulk migration.
- Missing or unknown stored values normalize to `native`; new records persist a validated ID.
- `native` has `configUrl: null`. Every remote entry has a fixed HTTPS raw URL under `ACL4SSR/ACL4SSR/master/Clash/config`.
- Remote `/config/<token>` conversion passes `/config/<token>?raw=1` as subconverter `url`; the public token URL itself remains unchanged after profile updates.
- `SUBCONVERTER_BACKEND` may override the trusted converter endpoint. `ACL4SSR_CONFIG_URL` remains the no-profile legacy `/clash` default only; it does not bypass stored-profile validation.
- The shared UI exposes the selector only when its runtime adapter supplies `conversionProfiles`. Local omits this capability and must neither render the selector nor send `conversionProfileId`.

### 4. Validation & Error Matrix

- POST/PUT with an unknown profile ID -> `400` and no KV write.
- Stored record without a profile -> native YAML and no subconverter request.
- Stored record with an unknown profile -> native YAML and no subconverter request.
- `/clash?profile=native` or an unknown ID -> `400` and no subconverter request.
- Missing KV binding -> the existing subscription API/config `503` response.
- Missing token -> `404`.
- Subconverter network failure -> `502`; an upstream HTTP response keeps its status.
- `?raw=1` -> stored YAML even when the record selects a remote profile; this is the recursion terminator.

### 5. Good / Base / Bad Cases

- Good: save `acl4ssr-online-mini`, request the stable token URL, and convert once with the matching official INI URL and a `raw=1` source URL.
- Base: load an old record without `conversionProfileId`; return its saved YAML exactly as before.
- Bad: submit an arbitrary URL as `conversionProfileId`; reject it before persistence or fetch.

### 6. Tests Required

- Core tests assert one native default, seven unique remote IDs, and only official ACL4SSR HTTPS config URLs.
- Worker tests assert create/edit round trips, omitted-field preservation, stable public URLs, old/unknown stored-value fallback, and invalid-write rejection without KV side effects.
- Conversion tests assert exact `config`, `url`, `target`, `emoji`, `udp`, and `list` query parameters; `raw=1` and native reads must make zero remote calls.
- Shared UI tests assert Edge payload/edit restoration and that a runtime without profile capability leaves Local editing state and payload unchanged.
- Dialog tests assert radio semantics, visible selection, keyboard activation, and constrained vertical scrolling; verify desktop and mobile layouts in a real browser.

### 7. Wrong vs Correct

#### Wrong

```ts
converter.searchParams.set("url", `/config/${token}`);
converter.searchParams.set("config", userProvidedUrl);
```

This recursively invokes conversion and turns the converter into an arbitrary remote-config fetcher.

#### Correct

```ts
const profileId = resolveClashConversionProfileId(record.conversionProfileId);
const profile = getClashConversionProfile(profileId);
if (!profile.configUrl) return storedYamlResponse(record);

const sourceUrl = new URL(`/config/${token}`, request.url);
sourceUrl.searchParams.set("raw", "1");
converter.searchParams.set("url", sourceUrl.toString());
converter.searchParams.set("config", profile.configUrl);
```

The raw route terminates recursion, and the shared catalog owns every remote URL.
