import type { ParsedNode } from "@subboost/core/types/node";

export interface NodeContentKeyOptions {
  ignoreServer?: boolean;
  ignorePort?: boolean;
  ignoreSni?: boolean;
  ignoreServername?: boolean;
}

function stableJsonStringifyWithKeyFilter(
  value: unknown,
  includeKey: (key: string) => boolean
): string {
  const seen = new WeakSet<object>();

  const normalize = (input: unknown): unknown => {
    if (!input || typeof input !== "object") return input;
    if (seen.has(input as object)) return null;
    seen.add(input as object);

    if (Array.isArray(input)) return input.map(normalize);

    const obj = input as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (!includeKey(key)) continue;
      out[key] = normalize(obj[key]);
    }
    return out;
  };

  return JSON.stringify(normalize(value));
}

export function stableJsonStringify(value: unknown): string {
  return stableJsonStringifyWithKeyFilter(value, () => true);
}

export function buildNodeContentKey(
  node: ParsedNode,
  opts?: NodeContentKeyOptions
): string {
  const record = node as unknown as Record<string, unknown>;
  const filtered = Object.fromEntries(
    Object.entries(record).filter(([key]) => {
      if (key === "name" || key === "_meta" || key.startsWith("_")) return false;
      if (opts?.ignoreServer && key === "server") return false;
      if (opts?.ignorePort && key === "port") return false;
      if (opts?.ignoreSni && key === "sni") return false;
      if (opts?.ignoreServername && key === "servername") return false;
      return true;
    })
  );

  // 节点内部字段不属于内容身份；例如机场轮换 reality-opts._spider-x
  // 时，节点的稳定身份不应随之变化。
  return stableJsonStringifyWithKeyFilter(filtered, (key) => !key.startsWith("_"));
}

export function buildScopedNodeIdentityKey(scope: string, node: ParsedNode): string {
  return `${scope.trim()}\u0000${buildNodeContentKey(node)}`;
}
