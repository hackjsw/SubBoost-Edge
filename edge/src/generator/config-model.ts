import { load } from "js-yaml";
import { REGION_PRESETS } from "@subboost/core/proxy-group-advanced";

export type RegionCount = { id: string; label: string; count: number };

export type GroupModel = {
  name: string;
  type: string;
  /** Members split by what they are. */
  nodes: string[];
  groups: string[];
  builtins: string[];
  regions: RegionCount[];
  rules: Array<{ label: string; count: number }>;
  ruleCount: number;
};

export type ConfigModel = {
  nodeCount: number;
  groupCount: number;
  ruleCount: number;
  regions: RegionCount[];
  groups: GroupModel[];
};

const GROUP_TYPE_LABELS: Record<string, string> = {
  select: "手动选择",
  "url-test": "自动测速",
  fallback: "故障转移",
  "load-balance": "负载均衡",
  relay: "链式",
};

export function groupTypeLabel(type: string): string {
  return GROUP_TYPE_LABELS[type] ?? type;
}

const BUILTIN_TARGETS = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]);

// Chinese keywords match as substrings; ASCII ones only as whole words so "US"
// does not match "Russia" or "Bonus".
const REGION_MATCHERS = REGION_PRESETS.filter((preset) => preset.id !== "other").map((preset) => ({
  id: preset.id,
  label: preset.label,
  test: (name: string) =>
    preset.keywords.some((keyword) =>
      /^[\x20-\x7e]+$/.test(keyword)
        ? new RegExp(`(^|[^a-z])${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(name)
        : name.includes(keyword)
    ),
}));

export function regionOf(name: string): { id: string; label: string } {
  const matcher = REGION_MATCHERS.find((item) => item.test(name));
  return matcher ? { id: matcher.id, label: matcher.label } : { id: "other", label: "其他" };
}

export function countRegions(names: string[]): RegionCount[] {
  const counts = new Map<string, RegionCount>();
  for (const name of names) {
    const region = regionOf(name);
    const current = counts.get(region.id) ?? { ...region, count: 0 };
    current.count += 1;
    counts.set(region.id, current);
  }
  // "其他" always last, otherwise by size.
  return [...counts.values()].sort((a, b) => (a.id === "other" ? 1 : b.id === "other" ? -1 : b.count - a.count));
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
}

function ruleSourceLabel(rule: string): { target: string; label: string } | null {
  const parts = rule.split(",").map((part) => part.trim());
  if (parts[0] === "MATCH") return parts[1] ? { target: parts[1], label: "MATCH（其余流量）" } : null;
  if (parts.length < 3) return null;
  const [type, payload, target] = parts;
  if (type === "RULE-SET") return { target, label: payload };
  if (type === "GEOSITE" || type === "GEOIP") return { target, label: `${type.toLowerCase()}:${payload}` };
  // Inline rules are grouped by kind; listing each domain would swamp the view.
  return { target, label: type };
}

/** Parses generated Clash YAML into what the preview shows. Never throws. */
export function buildConfigModel(yaml: string): ConfigModel | null {
  if (!yaml.trim()) return null;
  let config: Record<string, unknown>;
  try {
    const parsed = load(yaml);
    if (!parsed || typeof parsed !== "object") return null;
    config = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const nodeNames = asRecords(config.proxies)
    .map((proxy) => proxy.name)
    .filter((name): name is string => typeof name === "string");
  const nodeSet = new Set(nodeNames);
  const rawGroups = asRecords(config["proxy-groups"]);
  const groupSet = new Set(rawGroups.map((group) => String(group.name ?? "")));
  const rules = Array.isArray(config.rules) ? config.rules.filter((rule): rule is string => typeof rule === "string") : [];

  const rulesByTarget = new Map<string, Map<string, number>>();
  for (const rule of rules) {
    const source = ruleSourceLabel(rule);
    if (!source) continue;
    const bucket = rulesByTarget.get(source.target) ?? new Map<string, number>();
    bucket.set(source.label, (bucket.get(source.label) ?? 0) + 1);
    rulesByTarget.set(source.target, bucket);
  }

  const groups: GroupModel[] = rawGroups.map((group) => {
    const name = String(group.name ?? "");
    const members = Array.isArray(group.proxies) ? group.proxies.filter((item): item is string => typeof item === "string") : [];
    const nodes = members.filter((member) => nodeSet.has(member));
    const ruleBucket = rulesByTarget.get(name) ?? new Map<string, number>();
    return {
      name,
      type: typeof group.type === "string" ? group.type : "select",
      nodes,
      groups: members.filter((member) => groupSet.has(member)),
      builtins: members.filter((member) => BUILTIN_TARGETS.has(member)),
      regions: countRegions(nodes),
      rules: [...ruleBucket.entries()].map(([label, count]) => ({ label, count })),
      ruleCount: [...ruleBucket.values()].reduce((sum, count) => sum + count, 0),
    };
  });

  return {
    nodeCount: nodeNames.length,
    groupCount: rawGroups.length,
    ruleCount: rules.length,
    regions: countRegions(nodeNames),
    groups,
  };
}
