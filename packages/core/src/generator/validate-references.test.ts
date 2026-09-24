import { describe, expect, it } from "vitest";
import { validateProxyReferences } from "./validate-references";

describe("validateProxyReferences", () => {
  it("rejects missing references and group cycles", () => {
    expect(() => validateProxyReferences({
      proxies: [{ name: "Node", type: "trojan", "dialer-proxy": "Missing" }],
      "proxy-groups": [],
    })).toThrow("引用了不存在的代理");
    expect(() => validateProxyReferences({
      proxies: [],
      "proxy-groups": [
        { name: "A", type: "select", proxies: ["B"] },
        { name: "B", type: "select", proxies: ["A"] },
      ],
    })).toThrow("存在循环");
  });

  it("accepts builtin targets and provider references", () => {
    expect(() => validateProxyReferences({
      proxies: [{ name: "Node", type: "trojan" }],
      "proxy-providers": { remote: { type: "http", url: "https://example.com/sub" } },
      "proxy-groups": [{ name: "Proxy", type: "select", proxies: ["Node", "DIRECT"], use: ["remote"] }],
      listeners: [{ name: "mixed", proxy: "Proxy" }],
    })).not.toThrow();
  });
});
