# Remove duplicate ACL4SSR selector

## Goal

Make ACL4SSR profile selection a single-step workflow: users choose the profile in the configuration generator and do not have to choose it again when saving or updating a subscription.

## Confirmed Facts

- The quick-mode generator and subscription dialog currently receive the same `conversionProfileId` state.
- Subscription persistence already writes that shared profile ID; removing the duplicate dialog control does not require a KV or API contract change.
- The generator's ACL4SSR entry remains the only profile-selection surface.

## Requirements

- Remove the clickable `Clash 规则方案` / ACL4SSR profile selector from the save and update subscription dialog.
- Remove the nested conversion-profile dialog and UI-only state that exist solely for that duplicate selector.
- Preserve the shared conversion profile state and the existing save/update payload so the generator selection is still persisted.
- Keep subscription name, smart matching, automatic update, interval, warning copy, and save/update behavior unchanged.

## Acceptance Criteria

- [x] Saving a subscription after selecting an ACL4SSR template in the generator does not show a second profile selector.
- [x] Updating an existing subscription does not show a second profile selector.
- [x] The selected generator profile ID is still included in create and update payloads.
- [x] The quick-mode ACL4SSR picker and its seven official profiles continue to work.
- [x] Focus behavior, mobile layout, and existing save/update controls remain usable after the row is removed.
- [x] Affected UI tests, lint, and Edge and Local type checks pass.

## Out Of Scope

- Changing conversion profile definitions, remote ACL4SSR URLs, KV schema, API payloads, Cron behavior, or the generator picker design.
