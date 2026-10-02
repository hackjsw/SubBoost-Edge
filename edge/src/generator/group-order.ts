import { PROXY_GROUP_MODULES } from "@subboost/core/generator/proxy-groups";
import { resolveProxyGroupModuleName } from "@subboost/core/proxy-group-name";

type OrderSources = {
  proxyGroupNameOverrides?: Record<string, string>;
  customProxyGroups?: Array<{ id: string; name: string; enabled?: boolean }>;
  dialerProxyGroups?: Array<{ id: string; name: string; enabled?: boolean }>;
};

/**
 * Maps generated proxy-group names back to the store's order keys
 * (module:/custom:/dialer:/name:) so a reordered preview can be persisted.
 */
export function proxyGroupOrderKeys(names: string[], sources: OrderSources): string[] {
  const byName = new Map<string, string>();
  for (const groupModule of PROXY_GROUP_MODULES) {
    byName.set(
      resolveProxyGroupModuleName(groupModule, sources.proxyGroupNameOverrides?.[groupModule.id]),
      `module:${groupModule.id}`
    );
  }
  for (const group of sources.customProxyGroups ?? []) {
    if (group && group.enabled !== false) byName.set(group.name, `custom:${group.id}`);
  }
  for (const group of sources.dialerProxyGroups ?? []) {
    if (group && group.enabled !== false) byName.set(group.name, `dialer:${group.id}`);
  }
  return names.map((name) => byName.get(name) ?? `name:${name}`);
}

/** Moves `dragged` before or after `target` in `names`. */
export function moveName(names: string[], dragged: string, target: string, position: "before" | "after"): string[] {
  if (dragged === target) return names;
  const rest = names.filter((name) => name !== dragged);
  const index = rest.indexOf(target);
  if (index < 0) return names;
  rest.splice(position === "after" ? index + 1 : index, 0, dragged);
  return rest;
}
