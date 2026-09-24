import { describe, expect, it } from "vitest";
import { dedupeNodes, processData } from "./subscription";
import { utf8ToBase64 } from "./encoding";

describe("legacy subscription dedupe", () => {
  const nodes = [
    { ip: "edge.example.com", port: "443", name: "A", region: "US", protocol: "vless", link: "vless://id-a@edge.example.com:443?security=tls#A" },
    { ip: "edge.example.com", port: "443", name: "B", region: "US", protocol: "vless", link: "vless://id-b@edge.example.com:443?security=tls#B" },
  ];

  it("keeps legacy host-port dedupe by default", () => {
    expect(dedupeNodes(nodes)).toHaveLength(1);
  });

  it("can dedupe by credentials and transport identity", () => {
    expect(dedupeNodes(nodes, "identity")).toHaveLength(2);
    expect(dedupeNodes([nodes[0], { ...nodes[0], name: "A2", link: nodes[0].link.replace("#A", "#A2") }], "identity")).toHaveLength(1);
    expect(dedupeNodes([nodes[0], { ...nodes[0], link: nodes[0].link.replace("security=tls", "security=tls&type=ws&path=%2Fa") }], "identity")).toHaveLength(2);
  });

  it("preserves VMess nested transport settings while ignoring display names and key order", () => {
    const make = (value: unknown) => ({ ...nodes[0], protocol: "vmess", link: `vmess://${utf8ToBase64(JSON.stringify(value))}` });
    const first = make({ add: "example.com", id: "test", ps: "A", extra: { path: "/a", host: "example.com" } });
    const renamed = make({ extra: { host: "example.com", path: "/a" }, ps: "B", id: "test", add: "example.com" });
    const different = make({ add: "example.com", id: "test", ps: "A", extra: { path: "/b", host: "example.com" } });
    expect(dedupeNodes([first, renamed, different], "identity")).toHaveLength(2);
  });

  it("accepts SS/SSR links and preserves commas inside URI parameters", async () => {
    const ss = `ss://${utf8ToBase64("aes-128-gcm:secret")}@ss.example.com:8388#SS`;
    const ssr = `ssr://${utf8ToBase64(`ssr.example.com:8388:origin:aes-256-cfb:plain:${utf8ToBase64("secret")}/?remarks=${utf8ToBase64("SSR")}`)}`;
    const vless = "vless://test@example.com:443?security=tls&alpn=h2,http/1.1&type=ws&path=/a,b#Name";
    const parsed = await processData("", `${ss}\n${ssr}\n${vless},${nodes[0].link}`);
    expect(parsed.map(node => node.protocol)).toEqual(["ss", "ssr", "vless", "vless"]);
    expect(parsed[2].link).toBe(vless);
    expect(parsed[0]).toMatchObject({ ip: "ss.example.com", port: "8388" });
    expect(parsed[1]).toMatchObject({ ip: "ssr.example.com", port: "8388" });
  });

  it("still expands comma-separated addresses with a template", async () => {
    const parsed = await processData(nodes[0].link, "1.1.1.1:443,8.8.8.8:8443");
    expect(parsed.map(node => [node.ip, node.port])).toEqual([["1.1.1.1", "443"], ["8.8.8.8", "8443"]]);
  });
});
