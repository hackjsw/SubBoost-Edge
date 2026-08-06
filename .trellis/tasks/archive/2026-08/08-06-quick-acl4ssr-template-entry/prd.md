# Add quick-mode ACL4SSR template entry

## Goal

Make the existing ACL4SSR conversion profiles discoverable from Quick Mode by
placing a dedicated template row directly below the built-in Full template.

## Requirements

- Add an `ACL4SSR 模板` row after `精简版`, `标准版`, and `完整版` in the
  Quick Mode template selector when the runtime exposes remote conversion
  profiles.
- Match the compact layout and selection treatment of the three built-in
  template rows. Show that seven official profiles are available and surface
  the selected profile name when one is active.
- Open the existing Clash conversion profile dialog from the new row, limited
  to the seven ACL4SSR remote profiles; do not include the native profile in
  this entry-point dialog.
- Selecting an ACL4SSR profile updates the existing `conversionProfileId`
  state used by subscription persistence and scheduled refreshes.
- Treat the four Quick Mode rows as one choice group: selecting a built-in
  template resets the conversion profile to `native`, while selecting an
  ACL4SSR profile visually deselects the built-in rows.
- Keep the conversion-profile control in the subscription-link dialog as a
  secondary control for Advanced Mode and final confirmation.
- Keep the row capability-driven so runtimes without conversion profiles do
  not advertise unsupported behavior.
- Do not imply that the local YAML preview has already been converted by the
  remote ACL4SSR service; the selected profile applies to saved subscription
  output and scheduled refreshes.
- Document the seven profiles and their remote-update behavior in the project
  README.

## Acceptance Criteria

- [ ] Edge Quick Mode shows `ACL4SSR 模板` immediately below `完整版` and the
      existing built-in rows retain their current order.
- [ ] Opening the row shows exactly the seven official ACL4SSR profiles.
- [ ] Choosing a profile closes the dialog, updates the row label/state, and is
      carried into the existing subscription save payload.
- [ ] Choosing any built-in template restores the `native` conversion profile.
- [ ] Local/runtime configurations without remote profiles do not show the
      ACL4SSR row.
- [ ] README explains where to select the seven profiles and distinguishes
      subscription refreshes from KV template polling.
- [ ] Focused UI tests cover visibility, dialog options, profile selection, and
      native reset; lint and both runtime type checks pass.

## Notes

- Reuse `CLASH_CONVERSION_PROFILES` and `ClashConversionProfileDialog`; do not
  create a second ACL4SSR catalog or duplicate profile metadata.
- This is a lightweight shared-UI change; no Worker/KV conversion logic is in
  scope.
