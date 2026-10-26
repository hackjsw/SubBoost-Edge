import { describe, expect, it } from "vitest";
import { parseHysteria } from "./hysteria";
import { parseHysteria2 } from "./hysteria2";

describe("Hysteria protocol parsers", () => {
  it("parses Hysteria v1 aliases, defaults, and optional fields", () => {
    expect(
      parseHysteria(
        "hy://hy.example.com?auth=secret&protocol=wechat-video&sni=sni.example.com&allowInsecure=yes&alpn=h3,,h2&up=50&down=100&mport=1000-2000&obfsParam=mask&obfs=salamander&fast-open=off#HY"
      )
    ).toMatchObject({
      name: "HY",
      type: "hysteria",
      server: "hy.example.com",
      port: 443,
      protocol: "wechat-video",
      "auth-str": "secret",
      sni: "sni.example.com",
      "skip-cert-verify": true,
      alpn: ["h3", "h2"],
      up: "50",
      down: "100",
      ports: "1000-2000",
      obfs: "mask",
      _obfs: "salamander",
      "fast-open": false,
    });

    expect(parseHysteria("hysteria://hy.example.com:8443?password=secret&insecure=0")).toMatchObject({
      name: "Hysteria hy.example.com:8443",
      "auth-str": "secret",
      "skip-cert-verify": false,
    });
  });

  it("rejects malformed Hysteria v1 links", () => {
    expect(() => parseHysteria("http://bad")).toThrow("无效的 Hysteria 链接");
    expect(() => parseHysteria("hysteria://:443")).toThrow("Hysteria 配置缺少必要字段");
    expect(() => parseHysteria("hysteria://hy.example.com:70000")).toThrow("无效的端口号");
  });

  it("parses Hysteria2 query password, IPv6 authority, and rich TLS fields", () => {
    expect(
      parseHysteria2(
        "hy2://[2001:db8::1]:8443?password=secret&sni=sni.example.com&allow_insecure=true&alpn=h3,h2&fp=chrome&up=50&down=100mbps&mldsa65Seed=seed&hopInterval=15-30#IPv6"
      )
    ).toMatchObject({
      name: "IPv6",
      type: "hysteria2",
      server: "2001:db8::1",
      port: 8443,
      password: "secret",
      sni: "sni.example.com",
      "skip-cert-verify": true,
      alpn: ["h3", "h2"],
      fingerprint: "chrome",
      up: "50 mbps",
      down: "100mbps",
      "hop-interval": "15-30",
      "mldsa65-seed": "seed",
    });
  });

  it("parses Hysteria2 port ranges, query aliases, and salamander obfs", () => {
    const ranged = parseHysteria2(
      "hysteria2://secret@hy2.example.com:1000-1002?obfs=salamander&obfs_password=mask&upmbps=20&downmbps=30&hop-interval=10#Ports"
    );
    const queryPorts = parseHysteria2("hysteria2://hy2.example.com?auth=secret&mport=2000,2001");
    const ipv6Default = parseHysteria2(
      "hysteria2://secret@[2001:db8::2]///?obfs=none&alpn=,,&up=10kbps&down=20&hop-interval=0&hop_interval=5"
    );
    const queryAuthAlias = parseHysteria2(
      "hysteria2://alias.example.com?auth_str=query-secret&ports=3000-3002&hop-interval=30-15&hopInterval=20-30"
    );

    expect(ranged).toMatchObject({
      name: "Ports",
      server: "hy2.example.com",
      port: 1000,
      password: "secret",
      ports: "1000-1002",
      obfs: "salamander",
      "obfs-password": "mask",
      up: "20 mbps",
      down: "30 mbps",
      "hop-interval": 10,
    });
    expect(queryPorts).toMatchObject({
      name: "Hysteria2 节点",
      server: "hy2.example.com",
      port: 2000,
      password: "secret",
      ports: "2000,2001",
    });
    expect(ipv6Default).toMatchObject({
      server: "2001:db8::2",
      port: 443,
      password: "secret",
      sni: "2001:db8::2",
      up: "10kbps",
      down: "20 mbps",
      "hop-interval": 5,
    });
    expect(ipv6Default).not.toHaveProperty("obfs");
    expect(ipv6Default).not.toHaveProperty("alpn");
    expect(queryAuthAlias).toMatchObject({
      server: "alias.example.com",
      password: "query-secret",
      port: 3000,
      ports: "3000-3002",
      "hop-interval": "20-30",
    });
  });

  it("rejects malformed Hysteria2 links", () => {
    expect(() => parseHysteria2("http://bad")).toThrow("无效的 Hysteria2 链接");
    expect(() => parseHysteria2("hysteria2://@hy2.example.com:443")).toThrow("Hysteria2 配置缺少必要字段");
    expect(() => parseHysteria2("hysteria2://secret@hy2.example.com:70000")).toThrow("无效的端口号");
    expect(() => parseHysteria2("hysteria2://secret@hy2.example.com:443?obfs=salamander")).toThrow(
      "Hysteria2 salamander obfs 缺少 obfs-password"
    );
  });
});
