import type {
  CustomProxyGroup,
  ProxyGroupMemberRef,
  ProxyGroupRuleTarget,
  ProxyGroupTargetRef,
} from "@subboost/core/types/config";

export function isProxyGroupTargetRef(value: unknown): value is ProxyGroupTargetRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    (item.kind === "module" || item.kind === "custom") &&
    typeof item.id === "string" &&
    Boolean(item.id.trim())
  );
}

export function normalizeProxyGroupTargetRef(value: unknown): ProxyGroupTargetRef | null {
  if (!isProxyGroupTargetRef(value)) return null;
  return { kind: value.kind, id: value.id.trim() };
}

export function parseProxyGroupTargetValue(value: string): ProxyGroupTargetRef | null {
  const trimmed = value.trim();
  for (const kind of ["module", "custom"] as const) {
    const prefix = `${kind}:`;
    if (!trimmed.startsWith(prefix)) continue;
    const id = trimmed.slice(prefix.length).trim();
    return id ? { kind, id } : null;
  }
  return null;
}

type ProxyGroupTargetOptions = {
  moduleNames: Record<string, string>;
  customProxyGroups?: CustomProxyGroup[];
  literalTargetNames?: readonly string[];
};

export function normalizeProxyGroupRuleTarget(
  target: unknown,
  options: ProxyGroupTargetOptions
): ProxyGroupRuleTarget | null {
  if (typeof target !== "string") return normalizeProxyGroupTargetRef(target);
  const name = target.trim();
  if (!name) return null;
  const ref = parseProxyGroupTargetValue(name);
  if (!ref) return name;
  // Existing names take precedence over the reference shorthand.
  if (Object.values(options.moduleNames).some((value) => value.trim() === name) ||
      options.customProxyGroups?.some((group) => group.name.trim() === name) ||
      options.literalTargetNames?.some((value) => value.trim() === name)) return name;
  return ref;
}

export function isDisabledCustomProxyGroupTarget(
  target: ProxyGroupRuleTarget,
  options: ProxyGroupTargetOptions
): boolean {
  const disabled = (options.customProxyGroups || []).filter((group) => group.enabled === false);
  if (disabled.length === 0) return false;
  const normalized = normalizeProxyGroupRuleTarget(target, options);
  if (typeof normalized === "string") return disabled.some((group) => group.name.trim() === normalized);
  return normalized?.kind === "custom" && disabled.some((group) => group.id === normalized.id);
}

export function getProxyGroupTargetKey(target: ProxyGroupTargetRef): string {
  return `${target.kind}:${target.id}`;
}

export function getProxyGroupMemberKey(member: ProxyGroupMemberRef): string {
  switch (member.kind) {
    case "node":
      return `node:${member.name}`;
    case "module":
      return `module:${member.id}`;
    case "custom":
      return `custom:${member.id}`;
    case "direct":
      return "direct:DIRECT";
    case "reject":
      return "reject:REJECT";
  }
}

export function resolveProxyGroupTargetName(
  target: ProxyGroupRuleTarget,
  options: ProxyGroupTargetOptions & { fallbackTarget?: string }
): string {
  const normalized = normalizeProxyGroupRuleTarget(target, options);
  if (!normalized) return options.fallbackTarget || "";
  if (typeof normalized === "string") return normalized;

  if (normalized.kind === "module") {
    const moduleName = Object.prototype.hasOwnProperty.call(options.moduleNames, normalized.id)
      ? options.moduleNames[normalized.id]
      : undefined;
    return (typeof moduleName === "string" ? moduleName.trim() : "") || options.fallbackTarget || "";
  }

  const customName = (options.customProxyGroups || []).find((group) => group.id === normalized.id)?.name?.trim();
  return customName || options.fallbackTarget || "";
}

export function ruleTargetMatchesName(target: ProxyGroupRuleTarget, name: string): boolean {
  return typeof target === "string" && target.trim() === name.trim();
}
