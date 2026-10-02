import { describe, expect, it } from "vitest";
import { buildConfigModel, countRegions, regionOf } from "./config-model";

const YAML = `proxies:
  - { name: 香港 01, type: trojan, server: hk.example.com, port: 443, password: x }
  - { name: HK-02, type: trojan, server: hk2.example.com, port: 443, password: x }
  - { name: 日本 01, type: trojan, server: jp.example.com, port: 443, password: x }
  - { name: Russia 01, type: trojan, server: ru.example.com, port: 443, password: x }
proxy-groups:
  - { name: 谷歌服务, type: select, proxies: [自动选择, 香港 01, HK-02, 日本 01] }
  - { name: 自动选择, type: url-test, proxies: [香港 01, HK-02, 日本 01, Russia 01] }
  - { name: 广告拦截, type: select, proxies: [REJECT, DIRECT] }
rules:
  - RULE-SET,google,谷歌服务
  - GEOSITE,youtube,谷歌服务
  - DOMAIN-SUFFIX,a.com,谷歌服务
  - DOMAIN-SUFFIX,b.com,谷歌服务
  - RULE-SET,ads,广告拦截
  - MATCH,自动选择
`;

describe("config model", () => {
  it("classifies regions without matching ASCII keywords inside words", () => {
    expect(regionOf("香港 01").label).toBe("香港");
    expect(regionOf("HK-02").label).toBe("香港");
    expect(regionOf("Russia 01").label).toBe("其他");
    expect(countRegions(["香港 01", "HK-02", "日本 01", "Russia 01"])).toEqual([
      { id: "hk", label: "香港", count: 2 },
      { id: "jp", label: "日本", count: 1 },
      { id: "other", label: "其他", count: 1 },
    ]);
  });

  it("summarises nodes, groups, rules, and per-group flow", () => {
    const model = buildConfigModel(YAML)!;
    expect(model).toMatchObject({ nodeCount: 4, groupCount: 3, ruleCount: 6 });
    const google = model.groups.find((group) => group.name === "谷歌服务")!;
    expect(google.groups).toEqual(["自动选择"]);
    expect(google.regions.map((region) => region.label)).toEqual(["香港", "日本"]);
    expect(google.rules).toEqual([
      { label: "google", count: 1 },
      { label: "geosite:youtube", count: 1 },
      { label: "DOMAIN-SUFFIX", count: 2 },
    ]);
    expect(model.groups.find((group) => group.name === "广告拦截")!.builtins).toEqual(["REJECT", "DIRECT"]);
    expect(model.groups.find((group) => group.name === "自动选择")!.rules).toEqual([{ label: "MATCH（其余流量）", count: 1 }]);
  });

  it("returns null for empty or invalid YAML", () => {
    expect(buildConfigModel("")).toBeNull();
    expect(buildConfigModel("proxies: [")).toBeNull();
  });
});
