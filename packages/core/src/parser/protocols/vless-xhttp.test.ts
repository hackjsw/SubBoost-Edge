import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { parseVLESS } from "./vless";
import { parseSubscription } from "../index";
import { generateClashYaml } from "../../generator";
import { sanitizeMihomoProxyNode } from "../../mihomo/proxy-sanitizer";
import type { VLESSNode } from "../../types/node";

const uuid = "11111111-1111-4111-8111-111111111111";
const publicKey = "A".repeat(43);
const defaultReuse = { "max-connections": "3", "h-max-request-times": "600-900", "h-max-reusable-secs": "1800-3000" };
const uri = (extra: unknown, query = "security=tls") =>
  `vless://${uuid}@local.subboost.test:443?type=xhttp&${query}&extra=${encodeURIComponent(JSON.stringify(extra))}`;
function output(node: VLESSNode): VLESSNode {
  return (yaml.load(generateClashYaml({ nodes: [node], userConfig: { dnsYaml: "" } })) as { proxies: VLESSNode[] }).proxies[0];
}

describe("XHTTP share-link extra", () => {
  it("retains typed options, ranges, headers and all XMUX fields through final YAML", () => {
    const extra = {
      path: "/ignored", host: "ignored", mode: "invalid-but-outer-wins",
      headers: { "X-Test": "a%2Fb+value" }, noGRPCHeader: false,
      xPaddingBytes: "100-200", xPaddingObfsMode: true, xPaddingKey: "padding",
      xPaddingHeader: "X-Pad", xPaddingPlacement: "header", xPaddingMethod: "tokenish",
      uplinkHTTPMethod: "POST", sessionIDPlacement: "header", sessionIDKey: "X-Session",
      sessionIDTable: "hex", sessionIDLength: "16-32", seqPlacement: "query", seqKey: "seq",
      uplinkDataPlacement: "body", uplinkDataKey: "payload", uplinkChunkSize: "1024-2048",
      scMaxEachPostBytes: "100000-300000", scMinPostsIntervalMs: "10-30",
      xmux: { maxConcurrency: 0, maxConnections: "2-4", cMaxReuseTimes: 0, hMaxRequestTimes: "600-900", hMaxReusableSecs: "1800-3000", hKeepAlivePeriod: -1 },
      noSSEHeader: true,
    };
    const parsed = parseVLESS(uri(extra, "security=tls&path=/upload&host=local.subboost.test&mode=packet-up"));
    const opts = output(parsed)["xhttp-opts"]!;
    expect(opts).toEqual({
      path: "/upload", host: "local.subboost.test", mode: "packet-up",
      headers: { "X-Test": "a%2Fb+value" }, "no-grpc-header": false,
      "x-padding-bytes": "100-200", "x-padding-obfs-mode": true, "x-padding-key": "padding",
      "x-padding-header": "X-Pad", "x-padding-placement": "header", "x-padding-method": "tokenish",
      "uplink-http-method": "POST", "session-placement": "header", "session-key": "X-Session",
      "session-table": "hex", "session-length": "16-32", "seq-placement": "query", "seq-key": "seq",
      "uplink-data-placement": "body", "uplink-data-key": "payload", "uplink-chunk-size": "1024-2048",
      "sc-max-each-post-bytes": "100000-300000", "sc-min-posts-interval-ms": "10-30",
      "reuse-settings": { "max-concurrency": "0", "max-connections": "2-4", "c-max-reuse-times": "0", "h-max-request-times": "600-900", "h-max-reusable-secs": "1800-3000", "h-keep-alive-period": -1 },
    });
  });

  it("keeps explicit flat overrides and confines source defaults to extra", () => {
    const node = parseVLESS(uri({ noGRPCHeader: true, scMaxEachPostBytes: "100-200", xmux: { maxConnections: 3 } },
      "security=tls&no-grpc-header=false&scMaxEachPostBytes=200-300&maxConnections=0&hKeepAlivePeriod=-1"));
    expect(output(node)["xhttp-opts"]).toMatchObject({ "no-grpc-header": false,
      "sc-max-each-post-bytes": "200-300", "reuse-settings": { "max-connections": "0", "h-keep-alive-period": -1 } });
    expect(parseVLESS(uri({}))["xhttp-opts"]).toMatchObject({ path: "/", "session-table": "uuid", "reuse-settings": defaultReuse });
    expect(parseVLESS(`vless://${uuid}@local.subboost.test:443?type=xhttp`)["xhttp-opts"]).toEqual({ path: "/" });
  });

  it.each([null, [], "text", 1])("rejects non-object extra %j", extra => {
    expect(() => parseVLESS(uri(extra))).toThrow(/extra/);
  });
  it.each(["bad", "12garbage", "1.5", "-1", "2147483648", "1-2-3"])("rejects malformed ranges %s", value => {
    expect(() => parseVLESS(uri({ scMaxEachPostBytes: value }))).toThrow(/XHTTP/);
    expect(() => parseVLESS(uri({}, `security=tls&scMaxEachPostBytes=${value}`))).toThrow(/XHTTP/);
  });
  it("normalizes source ranges and zero defaults without changing canonical empty/default semantics", () => {
    for (const zero of [0, "", "0-0"]) {
      const opts = output(parseVLESS(uri({ xPaddingBytes: zero, scMaxEachPostBytes: zero, scMinPostsIntervalMs: zero })))["xhttp-opts"]!;
      expect(opts).toMatchObject({ "x-padding-bytes": "100-1000", "sc-max-each-post-bytes": 1000000, "sc-min-posts-interval-ms": "30" });
    }
    expect(output(parseVLESS(uri({ scMaxEachPostBytes: "+300-+100" })))["xhttp-opts"]!["sc-max-each-post-bytes"]).toBe("100-300");
    expect(() => parseVLESS(uri({ xPaddingBytes: "0-100" }))).toThrow(/零端点/);
    expect(output(parseVLESS(uri({ scMaxEachPostBytes: "30 - 40" })))["xhttp-opts"]!["sc-max-each-post-bytes"]).toBe("30-40");
    for (const [value, expected] of [["", ""], ["30 - 40", "30-40"], ["+30-+40", "30-40"]]) {
      const node = parseVLESS(uri({}));
      node["xhttp-opts"] = { "sc-min-posts-interval-ms": value, "reuse-settings": { "max-connections": value } };
      expect(output(node)["xhttp-opts"]).toEqual({ "sc-min-posts-interval-ms": expected, "reuse-settings": { "max-connections": expected } });
    }
  });
  it.each(["header", "cookie"])("materializes Xray %s upload and padding defaults", placement => {
    const opts = output(parseVLESS(uri({ uplinkDataPlacement: placement, xPaddingObfsMode: true, uplinkHTTPMethod: "get" }, "mode=packet-up")))["xhttp-opts"]!;
    expect(opts).toMatchObject({ "uplink-data-key": placement === "header" ? "X-Data" : "x_data", "uplink-http-method": "GET",
      "x-padding-key": "x_padding", "x-padding-header": "X-Padding", "x-padding-placement": "queryInHeader", "x-padding-method": "repeat-x" });
    if (placement === "header") expect(opts["uplink-chunk-size"]).toBe("3000-4000");
  });
  it("keeps partial XMUX settings and rejects conflicting concurrency or reserved session table semantics", () => {
    expect(parseVLESS(uri({ xmux: { maxConnections: 0 } }))["xhttp-opts"]!["reuse-settings"]).toEqual(defaultReuse);
    expect(parseVLESS(uri({ xmux: { maxConcurrency: 2 } }))["xhttp-opts"]!["reuse-settings"]).toEqual({ "max-concurrency": "2" });
    expect(() => parseVLESS(uri({ xmux: { maxConcurrency: 2, maxConnections: 2 } }))).toThrow(/xmux/);
    expect(() => parseVLESS(uri({ sessionIDTable: "uuid", sessionIDLength: 20 }))).toThrow(/保留字/);
  });
  it("derives source defaults after explicit flat overrides", () => {
    const opts = output(parseVLESS(uri({}, "mode=packet-up&uplinkDataPlacement=cookie&xPaddingObfsMode=true")))["xhttp-opts"]!;
    expect(opts).toMatchObject({ "uplink-data-key": "x_data", "x-padding-key": "x_padding", "x-padding-header": "X-Padding", "x-padding-placement": "queryInHeader", "x-padding-method": "repeat-x" });
    expect(output(parseVLESS(uri({ uplinkDataKey: "custom" }, "mode=packet-up&uplinkDataPlacement=cookie")))["xhttp-opts"]!["uplink-data-key"]).toBe("custom");
  });
  it("rejects broken JSON, invalid mode, and non-string extra headers", () => {
    const base = `vless://${uuid}@local.subboost.test:443?type=xhttp&extra=`;
    expect(() => parseVLESS(base + "%7B")).toThrow(/JSON/);
    expect(() => parseVLESS(uri({}, "mode=broken"))).toThrow(/mode/);
    expect(() => parseVLESS(uri({ headers: { nested: {} } }))).toThrow(/headers/);
    expect(() => parseVLESS(uri({ headers: { hOsT: "local.subboost.test" } }))).toThrow(/Host/);
    expect(() => parseVLESS(uri({ xPaddingBytes: "1".repeat(100000) }))).toThrow(/范围/);
  });
  it.each([
    { noGRPCHeader: "invalid" }, { xPaddingObfsMode: [] }, { xPaddingKey: 123 },
    { sessionIDPlacement: "invalid" }, { uplinkDataPlacement: "query" },
    { sessionIDTable: "abc" }, { sessionIDTable: 1 }, { xmux: [] },
    { xmux: { hKeepAlivePeriod: {} } }, { xmux: { hKeepAlivePeriod: "1.5" } },
    { headers: [] }, { scMinPostsIntervalMs: {} },
  ])("rejects malformed source transport settings %j", extra => {
    expect(() => parseVLESS(uri(extra))).toThrow(/XHTTP/);
  });
  it("retains explicit source defaults and URI aliases", () => {
    const node = parseVLESS(uri({ xmux: { hKeepAlivePeriod: "-1" }, uplinkHTTPMethod: "" },
      "mode=packet-up&noGRPCHeader=off&sessionIDPlacement=cookie&sessionIDKey=custom"));
    expect(output(node)["xhttp-opts"]).toMatchObject({ "uplink-http-method": "POST", "no-grpc-header": false,
      "session-placement": "cookie", "session-key": "custom", "reuse-settings": { "h-keep-alive-period": -1 } });
  });
  it.each([
    { "sc-max-each-post-bytes": 0 }, { "sc-min-posts-interval-ms": "0-0" },
    { "x-padding-bytes": "200-100" }, { "session-length": [] },
    { "no-grpc-header": "invalid" }, { "x-padding-obfs-mode": null },
    { headers: [] }, { "reuse-settings": null }, { path: {} },
  ])("does not emit invalid canonical YAML options %j", options => {
    const node = parseVLESS(uri({}));
    node["xhttp-opts"] = options as unknown as VLESSNode["xhttp-opts"];
    expect(sanitizeMihomoProxyNode(node)).toHaveProperty("_subboost-invalid-mihomo-node", true);
    expect((yaml.load(generateClashYaml({ nodes: [node] })) as { proxies: unknown[] | null }).proxies ?? []).toEqual([]);
  });
});

describe("XHTTP independent download settings", () => {
  const download = { address: "203.0.113.2", port: 8443, network: "xhttp" };
  it.each(["tls", "none"])("does not inherit uplink Reality, SNI, ALPN or headers for %s", security => {
    const main = parseVLESS(uri({ headers: { "X-Up": "up" }, xmux: { maxConnections: 3 },
      downloadSettings: { ...download, security } },
      `security=reality&pbk=${publicKey}&sni=local.subboost.test&fp=firefox&alpn=h2&path=/upload&host=local.subboost.test&allowInsecure=1`));
    const down = output(main)["xhttp-opts"]!["download-settings"]!;
    expect(down).toEqual({ server: "203.0.113.2", port: 8443, tls: security === "tls",
      servername: "", "client-fingerprint": "", "skip-cert-verify": false, alpn: [],
      "ech-opts": { enable: false }, path: "/", host: "", headers: {}, "reuse-settings": defaultReuse, "reality-opts": { "public-key": "" } });
  });
  it("maps independent TLS settings and nested extra headers/reuse", () => {
    const main = parseVLESS(uri({ downloadSettings: { ...download, security: "tls",
      tlsSettings: { serverName: "local.subboost.test", fingerprint: "firefox", alpn: ["h2"], allowInsecure: false },
      xhttpSettings: { path: "/down", headers: { Ignored: "outer" }, extra: { headers: { "X-Down": "value" }, xmux: { maxConnections: 2 } } } } }));
    expect(output(main)["xhttp-opts"]!["download-settings"]).toMatchObject({ server: "203.0.113.2", port: 8443,
      tls: true, servername: "local.subboost.test", "client-fingerprint": "firefox", alpn: ["h2"],
      "skip-cert-verify": false, path: "/down", headers: { "X-Down": "value" }, "reuse-settings": { "max-connections": "2" } });
  });
  it("maps independent Reality from its own security object and preserves false", () => {
    const main = parseVLESS(uri({ downloadSettings: { ...download, security: "reality",
      realitySettings: { password: publicKey, publicKey: "invalid-unused-key", shortId: "01ab", serverName: "local.subboost.test", fingerprint: "chrome", "support-x25519mlkem768": false },
      tlsSettings: { serverName: "ignored" } } }));
    expect(output(main)["xhttp-opts"]!["download-settings"]).toMatchObject({ tls: true, servername: "local.subboost.test", "client-fingerprint": "chrome",
      "reality-opts": { "public-key": publicKey, "short-id": "01ab", "support-x25519mlkem768": false } });
  });
  it("preserves canonical YAML inheritance, explicit clearing, and independent Reality", () => {
    for (const reality of [undefined, { "public-key": "" }, { "public-key": publicKey, "support-x25519mlkem768": false }]) {
      const node = parseVLESS(uri({}, `security=reality&pbk=${publicKey}`));
      node["xhttp-opts"]!["download-settings"] = { path: "/down", ...(reality ? { "reality-opts": reality } : {}) };
      const parsed = parseSubscription(yaml.dump({ proxies: [node] }));
      expect(parsed.errors).toEqual([]);
      const final = output(parsed.nodes[0] as VLESSNode);
      expect(final["xhttp-opts"]!["download-settings"]!["reality-opts"]).toEqual(reality);
    }
    const plain = parseVLESS(uri({}));
    plain["xhttp-opts"]!["download-settings"] = { "reality-opts": { "public-key": "" } };
    expect(output(plain)).toBeDefined();
  });
  it("rejects unsupported download transport and security semantics", () => {
    const bad = [
      { ...download, network: "grpc" }, { ...download, port: "8443bad" }, { ...download, port: 0 },
      { ...download, address: "" }, { ...download, security: "other" }, { ...download, security: "reality" },
      { ...download, xhttpSettings: { xPaddingBytes: "100-200" } }, { ...download, sockopt: {} },
      { ...download, security: "reality", realitySettings: { publicKey, mldsa65Verify: "key" } },
      { ...download, xhttpSettings: { path: "/download?token=demo" } },
    ];
    for (const value of bad) expect(() => parseVLESS(uri({ downloadSettings: value }))).toThrow(/XHTTP/);
    expect(() => parseVLESS(uri({ downloadSettings: download }, "mode=stream-one"))).toThrow(/stream-one/);
    expect(() => parseVLESS(uri({ xPaddingBytes: "100-200", downloadSettings: download }))).toThrow(/下行独立/);
    expect(sanitizeMihomoProxyNode({ type: "vless", network: "xhttp", "xhttp-opts": { mode: "bad" } })).toHaveProperty("_subboost-invalid-mihomo-node", true);
  });
  it.each(["pinnedPeerCertSha256", "verifyPeerCertByName", "minVersion", "maxVersion", "cipherSuites", "curvePreferences", "echSockopt", "useSystemCA"])("does not drop independent TLS constraint %s", key => {
    const values: Record<string, unknown> = { pinnedPeerCertSha256: "ab".repeat(32), verifyPeerCertByName: "local.subboost.test", curvePreferences: ["X25519"], echSockopt: {}, useSystemCA: true };
    expect(() => parseVLESS(uri({ downloadSettings: { ...download, security: "tls", tlsSettings: { [key]: values[key] ?? "1.3" } } }))).toThrow(key);
  });
  it("accepts a decimal string port and equivalent scalar/range defaults", () => {
    const node = parseVLESS(uri({ scMaxEachPostBytes: "1000000-1000000", downloadSettings: { ...download, port: "8443", xhttpSettings: { scMaxEachPostBytes: 1000000 } } }));
    expect(output(node)["xhttp-opts"]!["download-settings"]!.port).toBe(8443);
  });
  it("compares effective placement defaults for independent downloads", () => {
    const node = parseVLESS(uri({ sessionIDPlacement: "header", sessionIDKey: "X-Session", uplinkDataPlacement: "auto",
      downloadSettings: { ...download, xhttpSettings: { sessionIDPlacement: "header" } } }));
    expect(output(node)["xhttp-opts"]!["download-settings"]!.server).toBe("203.0.113.2");
  });
  it("allows upload-only options to differ from an independent download GET", () => {
    const node = parseVLESS(uri({ noGRPCHeader: true, scMaxEachPostBytes: 2000000, scMinPostsIntervalMs: 50,
      uplinkDataPlacement: "header", uplinkDataKey: "X-Payload", uplinkChunkSize: "2000-3000",
      uplinkHTTPMethod: "GET", sessionIDTable: "abcdef", sessionIDLength: 24, seqKey: "sequence",
      downloadSettings: download }, "mode=packet-up"));
    expect(output(node)["xhttp-opts"]!["download-settings"]!.server).toBe("203.0.113.2");
    expect(() => parseVLESS(uri({ seqPlacement: "header", downloadSettings: download }))).toThrow(/seq-placement/);
  });
  it.each([
    { ...download, address: 123 }, { ...download, xhttpSettings: [] },
    { ...download, xhttpSettings: { extra: [] } }, { ...download, xhttpSettings: { downloadSettings: {} } },
    { ...download, security: "tls", tlsSettings: { allowInsecure: "false" } },
    { ...download, security: "tls", tlsSettings: { alpn: "h2" } },
    { ...download, security: "reality", realitySettings: { publicKey, "support-x25519mlkem768": "false" } },
  ])("rejects malformed independent download settings %j", settings => {
    expect(() => parseVLESS(uri({ downloadSettings: settings }))).toThrow(/XHTTP/);
  });
  it("supports the standalone downloadSettings query and equivalent cookie session keys", () => {
    const source = { ...download, network: "splithttp", security: "", splithttpSettings: { path: "", sessionIDPlacement: "cookie", sessionIDKey: "x_session" } };
    const node = parseVLESS(`vless://${uuid}@local.subboost.test:443?type=xhttp&sessionIDPlacement=cookie&downloadSettings=${encodeURIComponent(JSON.stringify(source))}`);
    expect(output(node)["xhttp-opts"]!["download-settings"]).toMatchObject({ path: "/", tls: false, server: "203.0.113.2" });
  });
});
