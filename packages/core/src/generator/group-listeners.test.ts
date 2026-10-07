import { describe, expect, it } from "vitest";
import { generateClashConfig } from "./index";
import { GroupListenerError } from "./group-listeners";
import type { ParsedNode } from "@subboost/core/types/node";
import type { GroupListenerBinding } from "@subboost/core/types/config";

function ssNode(patch: Partial<ParsedNode> = {}): ParsedNode {
  return {
    name: "Node",
    type: "ss",
    server: "ss.example.com",
    port: 8388,
    cipher: "aes-128-gcm",
    password: "secret",
    ...patch,
  } as ParsedNode;
}

function binding(patch: Partial<GroupListenerBinding> = {}): GroupListenerBinding {
  return {
    id: "gl-1",
    target: { kind: "module", id: "auto" },
    port: 7891,
    ...patch,
  };
}

function findGroupListeners(config: ReturnType<typeof generateClashConfig>) {
  return ((config.listeners ?? []) as Array<Record<string, unknown>>).filter((l) =>
    String(l.name).startsWith("group-mixed-")
  );
}

describe("group listeners", () => {
  it("generates listeners for builtin, custom, and dialer groups by stable id", () => {
    const config = generateClashConfig({
      nodes: [ssNode()],
      customProxyGroups: [{ id: "custom-1", name: "C Custom", emoji: "C", groupType: "select" }],
      dialerProxyGroups: [
        {
          id: "dialer-1",
          name: "Chain",
          relayNodes: ["Node"],
          type: "select",
          targetNodes: [],
        },
      ],
      groupListeners: [
        binding({ id: "gl-1", target: { kind: "module", id: "auto" }, port: 7891 }),
        binding({ id: "gl-2", target: { kind: "custom", id: "custom-1" }, port: 7892 }),
        binding({ id: "gl-3", target: { kind: "dialer", id: "dialer-1" }, port: 7893 }),
      ],
      userConfig: { dnsYaml: "", enabledGroups: ["select", "auto", "global", "final"] },
    });

    expect(findGroupListeners(config)).toEqual([
      { name: "group-mixed-0", type: "mixed", listen: "127.0.0.1", port: 7891, proxy: "⚡ 自动选择", udp: true },
      { name: "group-mixed-1", type: "mixed", listen: "127.0.0.1", port: 7892, proxy: "C Custom", udp: true },
      { name: "group-mixed-2", type: "mixed", listen: "127.0.0.1", port: 7893, proxy: "Chain", udp: true },
    ]);
  });

  it("keeps listeners working after the target group is renamed", () => {
    const config = generateClashConfig({
      nodes: [ssNode()],
      proxyGroupNameOverrides: { auto: "改名后的自动" },
      groupListeners: [binding()],
      userConfig: { dnsYaml: "", enabledGroups: ["select", "auto", "global", "final"] },
    });

    expect(findGroupListeners(config)).toEqual([
      expect.objectContaining({ proxy: "⚡ 改名后的自动", port: 7891 }),
    ]);
  });

  it("listens on 0.0.0.0 only when allowLan is explicitly enabled", () => {
    const config = generateClashConfig({
      nodes: [ssNode()],
      groupListeners: [binding({ allowLan: true })],
      userConfig: { dnsYaml: "", enabledGroups: ["select", "auto", "global", "final"] },
    });

    expect(findGroupListeners(config)[0]).toMatchObject({ listen: "0.0.0.0" });
  });

  it("pauses generation while the binding or target group is disabled and resumes after re-enable", () => {
    const base = {
      nodes: [ssNode()],
      customProxyGroups: [
        { id: "custom-1", name: "C Custom", emoji: "C", groupType: "select" as const, enabled: false },
      ],
      groupListeners: [binding({ target: { kind: "custom" as const, id: "custom-1" }, port: 7892 })],
      userConfig: { dnsYaml: "", enabledGroups: ["select", "auto", "global", "final"] },
    };

    // 目标组停用：暂停生成，但不报错（配置保留）
    expect(findGroupListeners(generateClashConfig(base))).toEqual([]);

    // 重新启用：恢复生成
    const reEnabled = generateClashConfig({
      ...base,
      customProxyGroups: [{ ...base.customProxyGroups[0], enabled: true }],
    });
    expect(findGroupListeners(reEnabled)).toEqual([expect.objectContaining({ proxy: "C Custom" })]);

    // 绑定本身停用：同样暂停
    const bindingDisabled = generateClashConfig({
      ...base,
      customProxyGroups: [{ ...base.customProxyGroups[0], enabled: true }],
      groupListeners: [binding({ target: { kind: "custom", id: "custom-1" }, port: 7892, enabled: false })],
    });
    expect(findGroupListeners(bindingDisabled)).toEqual([]);
  });

  it("throws a clear error when the target group has been deleted", () => {
    expect(() =>
      generateClashConfig({
        nodes: [ssNode()],
        groupListeners: [binding({ target: { kind: "custom", id: "gone" } })],
        userConfig: { dnsYaml: "", enabledGroups: ["select", "auto", "global", "final"] },
      })
    ).toThrow(GroupListenerError);
    expect(() =>
      generateClashConfig({
        nodes: [ssNode()],
        groupListeners: [binding({ target: { kind: "custom", id: "gone" } })],
        userConfig: { dnsYaml: "", enabledGroups: ["select", "auto", "global", "final"] },
      })
    ).toThrow(/已被删除/);
  });

  it("rejects conflicts with the effective mixed-port from base YAML overrides", () => {
    expect(() =>
      generateClashConfig({
        nodes: [ssNode()],
        groupListeners: [binding({ port: 9999 })],
        userConfig: {
          dnsYaml: "mixed-port: 9999\n",
          enabledGroups: ["select", "auto", "global", "final"],
        },
      })
    ).toThrow(/mixed-port/);
  });

  it("rejects conflicts with node listener ports and base YAML listeners", () => {
    // 节点监听端口冲突
    expect(() =>
      generateClashConfig({
        nodes: [ssNode()],
        groupListeners: [binding({ port: 12000 })],
        userConfig: {
          dnsYaml: "",
          listenerPorts: { Node: 12000 },
          enabledGroups: ["select", "auto", "global", "final"],
        },
      })
    ).toThrow(/节点监听端口/);

    // 基础 YAML 已有 listeners 冲突
    expect(() =>
      generateClashConfig({
        nodes: [ssNode()],
        groupListeners: [binding({ port: 7000 })],
        userConfig: {
          dnsYaml: "listeners:\n  - name: base-in\n    type: mixed\n    port: 7000\n",
          enabledGroups: ["select", "auto", "global", "final"],
        },
      })
    ).toThrow(/listeners/);
  });

  it("rejects conflicts between two group listener bindings", () => {
    expect(() =>
      generateClashConfig({
        nodes: [ssNode()],
        customProxyGroups: [{ id: "custom-1", name: "C Custom", emoji: "C", groupType: "select" }],
        groupListeners: [
          binding({ id: "gl-1", target: { kind: "module", id: "auto" }, port: 7891 }),
          binding({ id: "gl-2", target: { kind: "custom", id: "custom-1" }, port: 7891 }),
        ],
        userConfig: { dnsYaml: "", enabledGroups: ["select", "auto", "global", "final"] },
      })
    ).toThrow(/冲突/);
  });

  it("keeps one port per group, merges after node listeners, and avoids name clashes", () => {
    const config = generateClashConfig({
      nodes: [ssNode()],
      groupListeners: [
        binding({ id: "gl-1", port: 7891 }),
        // 同一目标的第二条绑定被忽略（一组一端口）
        binding({ id: "gl-2", port: 7899 }),
      ],
      userConfig: {
        dnsYaml: "listeners:\n  - name: group-mixed-0\n    type: socks\n    port: 6000\n",
        listenerPorts: { Node: 12000 },
        enabledGroups: ["select", "auto", "global", "final"],
      },
    });

    const listeners = (config.listeners ?? []) as Array<Record<string, unknown>>;
    // 基础 YAML listeners 在前，节点监听随后，分组监听最后；名字避开 base 中的 group-mixed-0
    expect(listeners.map((l) => l.name)).toEqual(["group-mixed-0", "mixed0", "group-mixed-1"]);
    expect(listeners[2]).toMatchObject({ port: 7891, proxy: "⚡ 自动选择" });
  });
});
