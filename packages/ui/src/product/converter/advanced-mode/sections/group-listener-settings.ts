import yaml from "js-yaml";
import type { GroupListenerBinding, GroupListenerTarget } from "@subboost/core/types/config";

/** 分组监听端口冲突检查所需的最小状态切片 */
export interface GroupListenerConflictState {
  dnsYaml: string;
  mixedPort: number;
  listenerPorts: Record<string, number>;
  groupListeners: GroupListenerBinding[];
}

export function isSameGroupListenerTarget(a: GroupListenerTarget, b: GroupListenerTarget): boolean {
  return a.kind === b.kind && a.id === b.id;
}

export function findGroupListenerBinding(
  bindings: GroupListenerBinding[],
  target: GroupListenerTarget
): GroupListenerBinding | undefined {
  return bindings.find((b) => b && b.target && isSameGroupListenerTarget(b.target, target));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * 最终生效的 mixed-port：基础 YAML 显式给出时以 YAML 为准（生成器直接透传 YAML patch），
 * 否则回落到设置项 mixedPort。YAML 解析失败时同样回落（生成阶段会单独报 YAML 错误）。
 */
export function resolveEffectiveMixedPort(dnsYaml: string, mixedPort: number): number | undefined {
  const parsed = parseBaseYamlRecord(dnsYaml);
  if (parsed) {
    const fromYaml = parsed["mixed-port"];
    if (isValidPort(fromYaml)) return fromYaml;
    if (fromYaml !== undefined) return undefined;
    // 显式 YAML 中没有 mixed-port：生成结果里也不会有
    if (dnsYaml.trim()) return undefined;
  }
  return isValidPort(mixedPort) ? mixedPort : undefined;
}

function parseBaseYamlRecord(dnsYaml: string): Record<string, unknown> | null {
  if (!dnsYaml.trim()) return null;
  try {
    const parsed = yaml.load(dnsYaml) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function collectBaseYamlListenerPorts(dnsYaml: string): number[] {
  const parsed = parseBaseYamlRecord(dnsYaml);
  if (!parsed || !Array.isArray(parsed.listeners)) return [];
  return parsed.listeners
    .map((l) => (isRecord(l) ? l.port : undefined))
    .filter(isValidPort);
}

/**
 * 收集除指定目标之外所有已占用端口 → 冲突来源说明。
 * 覆盖：最终生效 mixed-port（含基础 YAML 覆盖）、节点监听端口、其他分组监听、基础 YAML listeners。
 */
export function collectUsedListenerPorts(
  state: GroupListenerConflictState,
  excludeTarget?: GroupListenerTarget
): Map<number, string> {
  const used = new Map<number, string>();
  const add = (port: number | undefined, label: string) => {
    if (isValidPort(port) && !used.has(port)) used.set(port, label);
  };

  add(resolveEffectiveMixedPort(state.dnsYaml, state.mixedPort), "全局 mixed-port");
  for (const port of Object.values(state.listenerPorts)) add(port, "节点监听端口");
  for (const port of collectBaseYamlListenerPorts(state.dnsYaml)) add(port, "基础和 DNS 配置中的 listeners");
  for (const binding of state.groupListeners) {
    if (!binding || !binding.target) continue;
    // 停用的绑定不参与生成，也不占用端口（与生成器一致）
    if (binding.enabled === false) continue;
    if (excludeTarget && isSameGroupListenerTarget(binding.target, excludeTarget)) continue;
    add(binding.port, "其他策略组的监听端口");
  }

  return used;
}

/** 校验端口输入；返回 null 表示可用，否则为错误文案。checkConflict=false 时只校验格式（停用的绑定不参与生成，无需无冲突） */
export function validateGroupListenerPort(
  portInput: string,
  state: GroupListenerConflictState,
  excludeTarget: GroupListenerTarget,
  opts?: { checkConflict?: boolean }
): { port: number; error: null } | { port: null; error: string } {
  const trimmed = portInput.trim();
  if (!trimmed) return { port: null, error: "请输入监听端口。" };
  const port = Number(trimmed);
  if (!isValidPort(port)) return { port: null, error: "端口需为 1-65535 的整数。" };
  if (opts?.checkConflict !== false) {
    const conflict = collectUsedListenerPorts(state, excludeTarget).get(port);
    if (conflict) return { port: null, error: `端口 ${port} 与${conflict}冲突。` };
  }
  return { port, error: null };
}
