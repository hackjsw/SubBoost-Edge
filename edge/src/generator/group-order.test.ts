import { describe, expect, it } from "vitest";
import { PROXY_GROUP_MODULES } from "@subboost/core/generator/proxy-groups";
import { moveName, proxyGroupOrderKeys } from "./group-order";

describe("proxy group order", () => {
  const [first, second] = PROXY_GROUP_MODULES;

  it("maps generated names back to module, renamed, custom, dialer, and unknown keys", () => {
    expect(
      proxyGroupOrderKeys([first.name, "🎯 我的分组", "自定义 A", "中转 1", "神秘组"], {
        proxyGroupNameOverrides: { [second.id]: "🎯 我的分组" },
        customProxyGroups: [{ id: "c1", name: "自定义 A" }],
        dialerProxyGroups: [{ id: "d1", name: "中转 1" }],
      })
    ).toEqual([`module:${first.id}`, `module:${second.id}`, "custom:c1", "dialer:d1", "name:神秘组"]);
  });

  it("ignores disabled custom groups", () => {
    expect(proxyGroupOrderKeys(["自定义 A"], { customProxyGroups: [{ id: "c1", name: "自定义 A", enabled: false }] })).toEqual([
      "name:自定义 A",
    ]);
  });

  it("moves a group before or after another", () => {
    expect(moveName(["a", "b", "c", "d"], "d", "b", "before")).toEqual(["a", "d", "b", "c"]);
    expect(moveName(["a", "b", "c", "d"], "a", "c", "after")).toEqual(["b", "c", "a", "d"]);
    expect(moveName(["a", "b"], "a", "a", "after")).toEqual(["a", "b"]);
  });
});
