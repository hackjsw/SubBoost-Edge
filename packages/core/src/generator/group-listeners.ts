/**
 * 分组监听：把绑定到策略组的本地 mixed 监听端口展开成 mihomo listeners 条目。
 *
 * mihomo 依据（wiki.metacubex.one/config/inbound/listeners/）：
 * - listener 的 proxy 字段可直接指向策略组，流量绕过 rules 固定出站；
 * - proxy 名称必须合法（真实存在的出站/策略组），否则 mihomo 报错；
 * - listen 控制监听地址；mixed 类型支持 udp: true。
 */

import type { GroupListenerBinding } from "@subboost/core/types/config";

export class GroupListenerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupListenerError";
  }
}

/** 目标策略组解析结果：exists = 配置里是否还有这个组；active = 该组当前是否参与生成 */
export interface GroupListenerTargetResolution {
  exists: boolean;
  active: boolean;
  /** 组当前显示名（exists 时必有） */
  name?: string;
}

export interface ResolveGroupListenersOptions {
  bindings: GroupListenerBinding[];
  /** 由稳定 ID 解析目标策略组（三类：module/custom/dialer） */
  resolveTarget: (binding: GroupListenerBinding) => GroupListenerTargetResolution;
  /** 最终生效的 mixed-port（含基础 YAML 覆盖值） */
  effectiveMixedPort?: number;
  /** 节点监听端口（listenerPorts 生成的 listeners） */
  nodeListenerPorts: number[];
  /** 基础 YAML 中已有的 listeners 占用的端口 */
  baseListenerPorts: number[];
  /** 已占用的 listener 名称（节点监听 + 基础 YAML listeners） */
  usedNames: Set<string>;
}

function isValidPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * 展开分组监听绑定。无效目标或端口冲突会抛出 GroupListenerError（不静默跳过）；
 * 仅"目标组存在但被停用"或"绑定本身被停用"时暂停生成（保留配置，不报错）。
 */
export function resolveGroupListenerEntries(
  options: ResolveGroupListenersOptions
): Array<Record<string, unknown>> {
  const { bindings, resolveTarget, effectiveMixedPort, nodeListenerPorts, baseListenerPorts, usedNames } = options;
  if (!Array.isArray(bindings) || bindings.length === 0) return [];

  const usedPorts = new Map<number, string>();
  if (isValidPort(effectiveMixedPort)) usedPorts.set(effectiveMixedPort, "全局 mixed-port");
  for (const port of nodeListenerPorts) {
    if (isValidPort(port) && !usedPorts.has(port)) usedPorts.set(port, "节点监听端口");
  }
  for (const port of baseListenerPorts) {
    if (isValidPort(port) && !usedPorts.has(port)) usedPorts.set(port, "基础和 DNS 配置中的 listeners");
  }

  const seenTargets = new Set<string>();
  const names = new Set(usedNames);
  const out: Array<Record<string, unknown>> = [];
  let autoIndex = 0;

  for (const binding of bindings) {
    if (!binding || typeof binding !== "object") continue;

    const resolution = resolveTarget(binding);
    if (!resolution.exists) {
      throw new GroupListenerError(
        "分组监听的目标策略组已被删除，请在对应策略组的高级设置中移除或修改该监听配置。"
      );
    }

    // 组存在但停用，或绑定本身停用：暂停生成，保留配置
    if (binding.enabled === false || !resolution.active) continue;

    const targetName = (resolution.name ?? "").trim();
    if (!targetName) {
      throw new GroupListenerError("分组监听的目标策略组名称为空，无法生成 listener。");
    }

    // 一组一端口：同一目标重复绑定只保留首条
    const targetKey = `${binding.target.kind}:${binding.target.id}`;
    if (seenTargets.has(targetKey)) continue;
    seenTargets.add(targetKey);

    if (!isValidPort(binding.port)) {
      throw new GroupListenerError(`策略组「${targetName}」的监听端口无效（需为 1-65535 的整数）。`);
    }
    const conflict = usedPorts.get(binding.port);
    if (conflict) {
      throw new GroupListenerError(
        `策略组「${targetName}」的监听端口 ${binding.port} 与${conflict}冲突，请修改后再生成。`
      );
    }
    usedPorts.set(binding.port, `策略组「${targetName}」的监听端口`);

    let name = `group-mixed-${autoIndex++}`;
    while (names.has(name)) name = `group-mixed-${autoIndex++}`;
    names.add(name);

    out.push({
      name,
      type: "mixed",
      // 默认仅本机可用；「允许局域网访问」需用户显式开启
      listen: binding.allowLan === true ? "0.0.0.0" : "127.0.0.1",
      port: binding.port,
      proxy: targetName,
      udp: true,
    });
  }

  return out;
}
