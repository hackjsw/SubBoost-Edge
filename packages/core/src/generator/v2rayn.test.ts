import { describe, expect, it } from "vitest";
import { dump } from "js-yaml";
import { decodeBase64 } from "../parser/base64";
import { parseNodeLink } from "../parser/parse-node-link";
import { generateV2rayNSubscription } from "./v2rayn";

const base = { name: "香港 + 测试 🌊", server: "example.com", port: 443 };
const uuid = "12345678-1234-1234-1234-123456789abc";

function exportNodes(nodes: unknown[], extra = {}) {
  const result = generateV2rayNSubscription(dump({ proxies: nodes, ...extra }));
  return { ...result, links: decodeBase64(result.content).split("\n") };
}

describe("v2rayN subscription export", () => {
  it.each([
    { type: "ss", cipher: "aes-128-gcm", password: "p:@#%41雪" },
    { type: "vmess", uuid, alterId: 0, cipher: "auto", tls: true },
    { type: "vless", uuid, tls: true },
    { type: "trojan", password: "p:@#%41雪" },
    { type: "hysteria2", password: "p:@#%41雪" },
    { type: "tuic", uuid, password: "p:@#%41雪" },
    { type: "anytls", password: "p:@#%41雪" },
  ])("round-trips $type credentials, unicode names and IPv6", (protocol) => {
    const node = { ...base, ...protocol, server: "2001:db8::1" };
    const result = exportNodes([node]);
    expect(result.nodeCount).toBe(1);
    expect(result.skippedNodes).toEqual([]);
    expect(parseNodeLink(result.links[0])).toMatchObject(node);
  });

  it("preserves REALITY keys, short id, flow, SNI and fingerprint", () => {
    const result = exportNodes([{
      ...base, type: "vless", uuid, tls: true, servername: "www.example.net",
      flow: "xtls-rprx-vision", "client-fingerprint": "chrome",
      "reality-opts": { "public-key": "a".repeat(43), "short-id": "000123ab" },
    }]);
    const url = new URL(result.links[0]);
    expect(url.searchParams.get("security")).toBe("reality");
    expect(url.searchParams.get("sid")).toBe("000123ab");
    expect(parseNodeLink(result.links[0])).toMatchObject({
      uuid, flow: "xtls-rprx-vision", servername: "www.example.net", "client-fingerprint": "chrome",
      "reality-opts": { "public-key": "a".repeat(43), "short-id": "000123ab" },
    });
  });

  it("keeps WebSocket paths, early data and httpupgrade", () => {
    const result = exportNodes([{
      ...base, type: "vless", uuid, network: "ws", tls: true,
      "ws-opts": { path: "/path?token=a+b%26c", headers: { Host: "cdn.example.com" }, "max-early-data": 2048, "v2ray-http-upgrade": true },
    }]);
    const query = new URL(result.links[0]).searchParams;
    expect(query.get("type")).toBe("httpupgrade");
    expect(query.get("path")).toBe("/path?token=a+b%26c&ed=2048");
    expect(parseNodeLink(result.links[0])).toMatchObject({
      "ws-opts": { path: "/path?token=a+b%26c", headers: { Host: "cdn.example.com" }, "max-early-data": 2048 },
    });
  });

  it("exports gRPC and XHTTP using v2rayN query names", () => {
    const result = exportNodes([
      { ...base, type: "trojan", password: "secret", network: "grpc", "grpc-opts": { "grpc-service-name": "a/b", _grpcAuthority: "cdn.example.com", _grpcType: "multi" } },
      { ...base, type: "vless", uuid, network: "xhttp", "xhttp-opts": { path: "/upload", host: "cdn.example.com", mode: "auto", "no-grpc-header": true, "x-padding-bytes": "100-200" } },
    ]);
    const grpc = new URL(result.links[0]).searchParams;
    expect(grpc.get("serviceName")).toBe("a/b");
    expect(grpc.get("authority")).toBe("cdn.example.com");
    const xhttp = new URL(result.links[1]).searchParams;
    expect(xhttp.get("type")).toBe("xhttp");
    expect(xhttp.get("mode")).toBe("auto");
    expect(JSON.parse(xhttp.get("extra")!)).toEqual({ noGRPCHeader: true, xPaddingBytes: "100-200" });
  });

  it("exports VMess gRPC in its JSON sharing schema", () => {
    const result = exportNodes([{ ...base, type: "vmess", uuid, network: "grpc", tls: true, "grpc-opts": { "grpc-service-name": "service", _grpcAuthority: "authority", _grpcType: "multi" } }]);
    expect(JSON.parse(decodeBase64(result.links[0].slice(8)))).toMatchObject({ net: "grpc", path: "service", host: "authority", type: "multi", tls: "tls", id: uuid });
  });

  it("preserves SS plugin options and Hysteria2 authentication/obfuscation", () => {
    const result = exportNodes([
      { ...base, type: "ss", cipher: "aes-128-gcm", password: "secret", plugin: "obfs", "plugin-opts": { mode: "http", host: "cdn.example.com" } },
      { ...base, type: "hysteria2", password: "secret", obfs: "salamander", "obfs-password": "ob%41+&fs", ports: "5000-6000", sni: "tls.example.com", "skip-cert-verify": true },
    ]);
    expect(parseNodeLink(result.links[0])).toMatchObject({ plugin: "obfs", "plugin-opts": { mode: "http", host: "cdn.example.com" } });
    expect(new URL(result.links[1]).searchParams.get("mport")).toBe("5000-6000");
    expect(parseNodeLink(result.links[1])).toMatchObject({ password: "secret", "obfs-password": "ob%41+&fs", sni: "tls.example.com", "skip-cert-verify": true });
  });

  it("reports skipped protocols, chained nodes, invalid nodes and providers", () => {
    const result = exportNodes([
      { ...base, type: "trojan", password: "keep" },
      { ...base, type: "snell", psk: "secret" },
      { ...base, type: "vless", uuid, "dialer-proxy": "relay" },
      { ...base, type: "vless", uuid, network: "h2" },
      { ...base, type: "trojan", port: 70000, password: "invalid" },
      null,
    ], { "proxy-providers": { remote: { url: "https://example.com/provider" } } });
    expect(result.nodeCount).toBe(1);
    expect(result.skippedNodes).toHaveLength(5);
    expect(result.providerCount).toBe(1);
    expect(result.links[0]).toContain("keep@");
  });

  it("rejects empty/provider-only/unsupported subscriptions rather than returning success", () => {
    expect(() => exportNodes([])).toThrow("没有可导出");
    expect(() => exportNodes([], { "proxy-providers": { remote: {} } })).toThrow("直接导入节点");
    expect(() => exportNodes([{ ...base, type: "ssr" }])).toThrow("没有可导出");
    expect(() => generateV2rayNSubscription("proxies: [")).toThrow("有效的 YAML");
  });

  it("does not silently lose advanced connection settings", () => {
    for (const options of [
      { network: "ws", "ws-opts": { headers: { Authorization: "secret" } } },
      { network: "xhttp", "xhttp-opts": { "download-settings": { path: "/download" } } },
      { "ech-opts": { enable: true, "query-server-name": "ech.example.com" } },
    ]) {
      expect(() => exportNodes([{ ...base, type: "vless", uuid, ...options }])).toThrow("没有可导出");
    }
  });

  it("preserves the snapshot's ordering, duplicate endpoints and renamed names", () => {
    const yaml = dump({ proxies: [
      { ...base, name: "renamed-first", type: "trojan", password: "first" },
      { ...base, name: "second", type: "trojan", password: "second" },
    ], rules: ["MATCH,DIRECT"], dns: { enable: true } });
    const original = yaml;
    const first = generateV2rayNSubscription(yaml);
    expect(first).toEqual(generateV2rayNSubscription(yaml));
    expect(yaml).toBe(original);
    expect(decodeBase64(first.content).split("\n").map(link => parseNodeLink(link)?.name)).toEqual(["renamed-first", "second"]);
  });
});
