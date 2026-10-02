import { describe, expect, it } from "vitest";
import { detectSource, isIpLiteralUrl, maskSubscriptionUrl, sourceTypeFor } from "./detect-source";

describe("detectSource", () => {
  it("splits one or more subscription URLs", () => {
    expect(detectSource(" https://sub.example.com/api?token=abc \n")).toEqual({
      kind: "urls",
      urls: ["https://sub.example.com/api?token=abc"],
    });
    expect(detectSource("https://a.example.com/s\nhttps://b.example.com/s")).toMatchObject({ kind: "urls", urls: ["https://a.example.com/s", "https://b.example.com/s"] });
  });

  it("recognises node links, Clash YAML, and base64 node lists", () => {
    expect(detectSource("vless://id@hk.example.com:443#HK\ntrojan://pw@jp.example.com:443#JP")).toMatchObject({ kind: "nodes", count: 2 });
    expect(detectSource("proxies:\n  - name: HK\n    type: trojan")).toMatchObject({ kind: "yaml" });
    const base64 = btoa("trojan://pw@jp.example.com:443#JP\nss://YWVz@hk.example.com:8388#HK");
    expect(detectSource(base64)).toMatchObject({ kind: "base64" });
    expect(sourceTypeFor(detectSource(base64))).toBe("nodes");
  });

  it("reports text it cannot classify", () => {
    expect(detectSource("流量已用完，请续费")).toMatchObject({ kind: "unknown" });
    expect(sourceTypeFor(detectSource("hello world"))).toBeNull();
  });
});

describe("source URL helpers", () => {
  it("flags IP-literal URLs that Workers cannot fetch", () => {
    expect(isIpLiteralUrl("https://179.255.115.32:2096/clash/abc")).toBe(true);
    expect(isIpLiteralUrl("https://[2001:db8::1]/sub")).toBe(true);
    expect(isIpLiteralUrl("https://sub.example.com/clash/abc")).toBe(false);
  });

  it("masks tokens in query strings and opaque path segments", () => {
    expect(maskSubscriptionUrl("https://sub.example.com/api/v1/client/subscribe?token=abcdef123456")).toBe(
      "https://sub.example.com/api/v1/client/subscribe?token=••••••••"
    );
    expect(maskSubscriptionUrl("https://179.255.115.32:2096/clash/3530f7f3b6758f7d6d44")).toBe(
      "https://179.255.115.32:2096/clash/••••••••"
    );
  });
});
