import { describe, expect, it } from "vitest";
import {
  BaseConfigYamlError,
  generateClashConfig,
  generateClashYaml,
  generateProxyGroups,
  generateRuleProviders,
  generateRules,
} from "@subboost/core/generator";
import { buildGenerateOptionsFromConfig } from "@subboost/core/subscription/config-utils";
import {
  normalizeProxyGroupAdvancedConfig,
  normalizeProxyGroupMemberRef,
  resolveProxyGroupMembers,
} from "@subboost/core/proxy-group-advanced";
import { withNodeSourceId } from "@subboost/core/subscription/node-source-state";
import type { ParsedNode } from "@subboost/core/types/node";

function node(name: string, patch: Partial<ParsedNode> = {}): ParsedNode {
  return {
    name,
    type: "ss",
    server: `${name.toLowerCase().replace(/\s+/g, "-")}.example.com`,
    port: 8388,
    cipher: "aes-128-gcm",
    password: "secret",
    ...patch,
  } as ParsedNode;
}

describe("local shared core generation contract", () => {
  it("builds a full local-consumer config from persisted options and mixed node inputs", () => {
    const persisted = buildGenerateOptionsFromConfig(
      {
        template: "full",
        enabledGroups: ["select", "auto", "ai", "private", "cn", "global", "final"],
        enabledRules: ["cn", "global", "final"],
        dnsYaml: [
          "mixed-port: 7897",
          "allow-lan: true",
          "global-client-fingerprint: chrome",
          "proxy-providers:",
          "  base:",
          "    type: http",
          "listeners:",
          "  - name: base-listener",
          "    type: mixed",
          "    port: 18080",
          "nameserver-policy:",
          "  geosite:cn: 223.5.5.5",
        ].join("\n"),
        customRules: [
          { type: "IP-CIDR", value: "203.0.113.0/24", target: { kind: "custom", id: "media" }, noResolve: true },
          { type: "PROCESS-NAME", value: " curl ", target: "Missing", noResolve: true },
        ],
        customProxyGroups: [
          {
            id: "media",
            name: "Media",
            emoji: "",
            includeInGroupMembers: true,
            memberSource: "filtered-nodes",
            groupType: "load-balance",
            strategy: "round-robin",
            advanced: {
              sourceIds: ["source-a"],
              regions: ["us", "other"],
              includeRegex: "Node|DIRECT",
              excludeRegex: "Bad",
              extraMembers: [{ kind: "direct" }],
              excludedMembers: [{ kind: "reject" }],
              memberOrder: [{ kind: "direct" }, { kind: "node", name: "US Node" }],
            },
          },
          { id: "disabled", name: "Disabled", emoji: "", groupType: "select", enabled: false },
        ],
        dialerProxyGroups: [
          {
            id: "chain",
            name: "Chain",
            type: "fallback",
            enabled: true,
            // A target cannot also be a relay: US Node → Chain → US Node is rejected as a cycle.
            relayNodes: ["DIRECT", "Missing Relay"],
            targetNodes: ["US Node", "Missing Target"],
          },
          {
            id: "empty",
            name: "Empty",
            type: "select",
            enabled: true,
            relayNodes: ["Missing Relay"],
            targetNodes: ["US Node"],
          },
          {
            id: "disabled",
            name: "Disabled Chain",
            type: "select",
            enabled: false,
            relayNodes: ["DIRECT"],
            targetNodes: ["US Node"],
          },
        ],
        listenerPorts: {
          "US Node": 12001,
          "US Node (2)": 12002,
          bad: 70000,
        },
        proxyGroupAdvanced: {
          ai: {
            groupType: "fallback",
            extraMembers: [{ kind: "custom", id: "media" }],
            excludedMembers: [{ kind: "node", name: "Bad Node" }],
          },
        },
        proxyGroupNameOverrides: {
          ai: "AI Local",
          final: "Final Local",
        },
        proxyGroupOrder: ["custom:media", "dialer:chain", "module:select"],
        ruleProviderBaseUrl: "https://rules.example.com",
        experimentalCnUseCnRuleSet: true,
        cnIpNoResolve: true,
      },
      {
        nodes: [
          withNodeSourceId(node("US Node"), "source-a"),
          withNodeSourceId(node("US Node"), "source-b"),
          node("余额 | 10GB"),
          node("Bad Node"),
          node("Legacy", { type: "socks4" } as Partial<ParsedNode>),
          node("VLESS", {
            type: "vless",
            uuid: "11111111-1111-4111-8111-111111111111",
            tls: true,
            network: "xhttp",
            "reality-opts": {
              "public-key": "A".repeat(43),
            },
          } as Partial<ParsedNode>),
        ],
        proxyProviders: {
          remote: { type: "http", url: "https://nodes.example.com/sub" },
        },
      },
    );
    const config = generateClashConfig({
      ...persisted,
      proxyGroupOrder: ["custom:media", "dialer:chain", "module:select"],
    });
    const groups = config["proxy-groups"] as Array<{ name: string; type: string; proxies?: string[]; use?: string[] }>;
    const rules = config.rules as string[];
    const proxies = config.proxies as Array<Record<string, unknown>>;
    const providers = config["proxy-providers"] as Record<string, unknown>;
    const listeners = config.listeners as Array<Record<string, unknown>>;

    expect(proxies.map((proxy) => proxy.name)).toContain("US Node (2)");
    expect(proxies.map((proxy) => proxy.name)).not.toContain("Legacy");
    expect(proxies.find((proxy) => proxy.name === "VLESS")).toMatchObject({ "client-fingerprint": "chrome" });
    expect(proxies.find((proxy) => proxy.name === "US Node")).toMatchObject({ "dialer-proxy": "Chain" });
    expect(proxies.find((proxy) => proxy.name === "US Node (2)")).not.toHaveProperty("dialer-proxy");
    expect(groups[0]).toMatchObject({ name: "Media", type: "load-balance", proxies: ["DIRECT", "US Node"] });
    expect(groups[1]).toMatchObject({ name: "Chain", type: "fallback" });
    expect(groups.find((group) => group.name === "🚀 节点选择")?.proxies).toContain("余额 | 10GB");
    expect(groups.find((group) => group.name === "🤖 AI Local")).toMatchObject({
      type: "fallback",
      proxies: expect.arrayContaining(["Media", "US Node"]),
    });
    expect(providers).toHaveProperty("base");
    expect(providers).toHaveProperty("remote");
    expect(listeners.map((listener) => listener.name)).toEqual(["base-listener", "mixed0", "mixed1"]);
    expect(rules).toContain("IP-CIDR,203.0.113.0/24,Media,no-resolve");
    expect(rules).toContain("PROCESS-NAME,curl,Media");
    expect(rules).toContain("RULE-SET,cn,🔒 国内服务");
    expect(rules.at(-1)).toBe("MATCH,🐟 Final Local");
    expect(generateClashYaml({ ...persisted })).toContain("proxy-groups:");
  });

  it("preserves local proxy-group member and rule provider fallbacks", () => {
    expect(normalizeProxyGroupMemberRef({ kind: "node", name: " Node A " })).toEqual({ kind: "node", name: "Node A" });
    expect(normalizeProxyGroupMemberRef({ kind: "module", id: " " })).toBeNull();
    expect(
      normalizeProxyGroupAdvancedConfig({
        sourceIds: ["source-a", "source-a", ""],
        regions: ["KR", "bad"],
        groupType: "load-balance",
        strategy: "bad",
        extraMembers: [{ kind: "direct" }, { kind: "direct" }],
      }),
    ).toEqual({
      sourceIds: ["source-a"],
      regions: ["kr"],
      groupType: "load-balance",
      strategy: "consistent-hashing",
      extraMembers: [{ kind: "direct" }],
    });

    const members = resolveProxyGroupMembers({
      defaultProxyNames: ["Korea Node", "DIRECT", "REJECT"],
      nodes: [withNodeSourceId(node("Korea Node"), "source-a"), withNodeSourceId(node("US Node"), "source-b")],
      moduleNames: { auto: "Auto" },
      customProxyGroups: [{ id: "custom", name: "Custom", emoji: "", groupType: "select" }],
      advanced: {
        sourceIds: ["source-a"],
        regions: ["kr"],
        extraMembers: [{ kind: "node", name: "US Node" }, { kind: "custom", id: "custom" }],
        excludedMembers: [{ kind: "reject" }],
        memberOrder: [{ kind: "custom", id: "custom" }, { kind: "node", name: "US Node" }],
      },
    });
    const groups = generateProxyGroups({
      nodes: [node("Node A"), node("余额 | 1GB")],
      enabledModules: ["auto", "private", "final"],
      ruleProviderBaseUrl: "https://rules.example.com",
      testUrl: "https://probe.example.com/204",
      testInterval: 120,
      customProxyGroups: [
        { id: "direct", name: "Direct", emoji: "", groupType: "direct-first", includeInGroupMembers: true },
        { id: "reject", name: "Reject", emoji: "", groupType: "reject-first" },
      ],
    });
    const providers = generateRuleProviders({
      nodes: [node("Node A")],
      enabledModules: ["cn"],
      ruleProviderBaseUrl: "https://rules.example.com",
      testUrl: "https://probe.example.com/204",
      testInterval: 120,
      customRuleSets: [
        { id: "relative", name: "Relative", behavior: "domain", path: "geosite/relative.mrs", target: "DIRECT" },
        { id: "absolute", name: "Absolute", behavior: "domain", path: "https://rules.example.com/absolute.mrs", target: "DIRECT" },
      ],
    });
    const rules = generateRules({
      enabledModules: ["cn", "global", "final"],
      customRules: [
        { id: "cidr", type: "IP-CIDR", value: "203.0.113.0/24", target: "Missing", noResolve: true },
        { id: "process", type: "PROCESS-NAME", value: "curl", target: "DIRECT", noResolve: true },
      ],
      customRuleSets: [
        { id: "set", name: "Set", behavior: "domain", path: "https://rules.example.com/set.mrs", target: "Missing", noResolve: true },
      ],
      experimentalCnUseCnRuleSet: true,
      availablePolicyTargets: ["DIRECT", "🐟 漏网之鱼"],
      fallbackPolicyTarget: "DIRECT",
      ruleOrder: ["custom-rule:process", "special:experimental-cn", "module:global:geolocation-!cn"],
    });

    expect(members.proxyNames).toEqual(["Custom", "US Node", "Korea Node", "DIRECT"]);
    expect(members.excluded.map((member) => member.key)).toEqual(["reject:REJECT"]);
    expect(groups.find((group) => group.name === "⚡ 自动选择")?.proxies).toEqual(["Node A"]);
    expect(groups.find((group) => group.name === "Direct")?.proxies?.slice(0, 2)).toEqual(["DIRECT", "REJECT"]);
    expect(groups.find((group) => group.name === "Reject")?.proxies?.slice(0, 2)).toEqual(["REJECT", "DIRECT"]);
    expect(providers.relative?.url).toBe("https://rules.example.com/geosite/relative.mrs");
    expect(providers.absolute?.url).toBe("https://rules.example.com/absolute.mrs");
    expect(rules).toContain("IP-CIDR,203.0.113.0/24,DIRECT,no-resolve");
    expect(rules).toContain("PROCESS-NAME,curl,DIRECT");
    expect(rules).not.toContain("PROCESS-NAME,curl,DIRECT,no-resolve");
    expect(rules).toContain("RULE-SET,set,DIRECT,no-resolve");
    expect(rules).toContain("RULE-SET,cn,DIRECT");
  });

  it("rejects unsafe base YAML sections before local YAML generation", () => {
    expect(() => generateClashConfig({ nodes: [], userConfig: { dnsYaml: "[]" } })).toThrow(BaseConfigYamlError);
    expect(() => generateClashConfig({ nodes: [], userConfig: { dnsYaml: "rules: []" } })).toThrow(
      "基础和 DNS 配置不能包含 rules"
    );
    expect(() =>
      generateClashConfig({
        nodes: [],
        userConfig: {
          dnsYaml: ["nameserver-policy:", "  geosite:cn: 223.5.5.5", "dns: disabled"].join("\n"),
        },
      })
    ).toThrow("dns 必须是对象");
    expect(() =>
      generateClashConfig({
        nodes: [node("Node A")],
        userConfig: {
          dnsYaml: "listeners: invalid",
          listenerPorts: { "Node A": 12000 },
        },
      })
    ).toThrow("listeners 必须是数组");
    expect(() =>
      generateClashConfig({
        nodes: [],
        proxyProviders: { remote: { type: "http" } },
        userConfig: {
          dnsYaml: "proxy-providers: invalid",
        },
      })
    ).toThrow("proxy-providers 必须是对象");
  });
});
