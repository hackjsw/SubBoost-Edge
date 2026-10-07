import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CustomRoutingRuleSetItem } from "@subboost/core/rules/custom-routing-rule-sets";
import type { CustomProxyGroup, CustomRule } from "@subboost/core/types/config";

vi.mock("lucide-react", () => ({
  ArrowRight: () => null,
  Shield: () => null,
}));

import { CustomRulesPreview } from "./custom-rules-preview";

describe("CustomRulesPreview", () => {
  it("renders nothing when there are no custom rules or rule sets", () => {
    expect(
      renderToStaticMarkup(
        React.createElement(CustomRulesPreview, {
          customRules: [],
          moduleNames: {},
          customProxyGroups: [],
        }),
      ),
    ).toBe("");
  });

  it("renders custom rules, rule sets, no-resolve labels, and overflow summary", () => {
    const customRules: CustomRule[] = Array.from({ length: 9 }, (_, index) => ({
      id: index === 0 ? "" : `rule-${index}`,
      type: index === 0 ? "DOMAIN-SUFFIX" : "IP-CIDR",
      value: `example-${index}.com`,
      target: index % 2 === 0 ? "PROXY" : "DIRECT",
      noResolve: index % 3 === 0,
    }));
    const ruleSets: CustomRoutingRuleSetItem[] = [
      {
        key: "set-1",
        source: { kind: "custom-rule-set", id: "set-1" },
        id: "set-1",
        name: "private",
        behavior: "domain",
        noResolve: true,
        path: "rules/private.yaml",
        target: { kind: "module", id: "reject", name: "REJECT", value: "module:reject" },
      },
      {
        key: "set-2",
        source: { kind: "custom-rule-set", id: "set-2" },
        id: "set-2",
        name: "direct",
        behavior: "ipcidr",
        path: "rules/direct.yaml",
        target: { kind: "module", id: "direct", name: "DIRECT", value: "module:direct" },
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(CustomRulesPreview, {
        customRules,
        ruleSets,
        moduleNames: { direct: "DIRECT", reject: "REJECT" },
        customProxyGroups: [],
      }),
    );

    expect(html).toContain("自定义规则");
    expect(html).toContain("(11)");
    expect(html).toContain("DOMAIN-SUFFIX");
    expect(html).toContain("RULE-SET");
    expect(html).toContain("no-resolve");
    expect(html).toContain("... 还有 1 条规则");
    expect(html).toContain("rules/private.yaml");
  });

  it("resolves structured targets and fails safe for unavailable targets", () => {
    const customProxyGroups: CustomProxyGroup[] = [
      {
        id: "custom-1",
        name: "🎬 影音分流",
        emoji: "🎬",
        groupType: "select",
      },
    ];
    const customRules: CustomRule[] = [
      {
        id: "module-target",
        type: "DOMAIN",
        value: "module.example",
        target: { kind: "module", id: "auto" },
      },
      {
        id: "custom-target",
        type: "DOMAIN",
        value: "custom.example",
        target: { kind: "custom", id: "custom-1" },
      },
      {
        id: "disabled-target",
        type: "DOMAIN",
        value: "disabled.example",
        target: { kind: "custom", id: "disabled-1" },
      },
      {
        id: "missing-target",
        type: "DOMAIN",
        value: "missing.example",
        target: { kind: "custom", id: "missing-1" },
      },
      {
        id: "blank-target",
        type: "DOMAIN",
        value: "blank.example",
        target: "   ",
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(CustomRulesPreview, {
        customRules,
        moduleNames: { auto: "🚀 节点选择" },
        customProxyGroups,
      }),
    );

    expect(html).toContain("🚀 节点选择");
    expect(html).toContain("🎬 影音分流");
    expect(html.match(/>目标分流组不可用</g)).toHaveLength(3);
    expect(html).not.toContain("module:auto");
    expect(html).not.toContain("custom:custom-1");
    expect(html).not.toContain("custom:disabled-1");
    expect(html).not.toContain("custom:missing-1");
  });
});
