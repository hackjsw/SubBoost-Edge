# State Management

Use component state for loading, selection, dialogs, and request progress local
to one surface. Server data is fetched through the surface adapter and refreshed
after mutations; this repository does not use React Query or SWR.

Use the existing Zustand stores only for established cross-surface concerns:

- `config-store` persists configuration to local storage and regenerates YAML
  through its action modules.
- `user-store` owns `/api/auth/me` and logout state and coalesces concurrent
  user loads with a singleton promise.
- `ui-store` carries transient subscription editing state and is intentionally
  not persisted.

Do not create an application-specific duplicate of these stores in `local` or
`edge`. Do not persist request progress or server cache snapshots in Zustand.
When changing user scope, preserve the reset behavior in `config-store` so one
user's persisted config is not shown to another.

### Preserve Pre-Dialog Subscription Choices

Subscription-scoped controls may be exposed before the save dialog opens. For
new subscriptions, dialog initialization must preserve a currently selected
value when it is still present in the adapter's allowlist. For edits, restore
the saved value and fall back to the adapter default only when it is invalid.
This prevents opening a dialog from silently undoing a choice made elsewhere
on the same surface.

```tsx
setProfileId((current) => {
  if (!isEditing && profiles.some((profile) => profile.id === current)) return current;
  return resolveSavedOrDefaultProfileId();
});
```
