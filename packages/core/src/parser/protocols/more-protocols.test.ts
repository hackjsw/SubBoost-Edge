import { describe, expect, it } from "vitest";
import { parseAnyTLS } from "./anytls";
import { parseTrojan } from "./trojan";
import { parseTuic } from "./tuic";
import { parseWireGuard } from "./wireguard";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("additional protocol parser contracts", () => {
  it("parses AnyTLS encoded userinfo and rejects unsupported advanced params", () => {
    const encoded = Buffer.from(`prefix:secret@anytls.example.com:443`).toString("base64url");
    const node = parseAnyTLS(
      `anytls://${encoded}?sni=sni.example.com&alpn=h2,http/1.1&fp=chrome&udp=0&ech=${Buffer.from("ech").toString("base64")}&idle-session-check-interval=10&idle-session-timeout=20&min-idle-session=2&padding-scheme=pad&pcs=pcs&pqv=pqv#AnyTLS`
    );

    expect(node).toMatchObject({
      name: "AnyTLS",
      type: "anytls",
      server: "anytls.example.com",
      password: "secret",
      udp: false,
      sni: "sni.example.com",
      alpn: ["h2", "http/1.1"],
      "client-fingerprint": "chrome",
      "ech-opts": { enable: true },
      "idle-session-check-interval": 10,
      "idle-session-timeout": 20,
      "min-idle-session": 2,
      "padding-scheme": "pad",
      pcs: "pcs",
      pqv: "pqv",
    });
    expect(() => parseAnyTLS("http://bad")).toThrow("无效的 AnyTLS 链接");
    expect(() => parseAnyTLS("anytls://secret@:443")).toThrow("AnyTLS 配置缺少必要字段");
    expect(() => parseAnyTLS("anytls://secret@anytls.example.com:70000")).toThrow("无效的端口号");
    expect(() => parseAnyTLS("anytls://secret@anytls.example.com:443?security=reality")).toThrow("AnyTLS 不支持 security=reality");
    expect(() => parseAnyTLS("anytls://secret@anytls.example.com:443?type=ws")).toThrow("AnyTLS 不支持 type=ws");
    expect(() => parseAnyTLS("anytls://secret@anytls.example.com:443?path=/ws")).toThrow("AnyTLS 不支持传输层参数");
  });

  it("parses AnyTLS direct credentials, query credentials, and stricter reject paths", () => {
    expect(
      parseAnyTLS(
        "anytls://user:pass@direct.example.com?security=none&type=none&headerType=none&peer=peer.example.com&allow_insecure=true&udp=maybe&fingerprint=firefox&ech=&remarks=Direct"
      )
    ).toMatchObject({
      name: "Direct",
      server: "direct.example.com",
      port: 443,
      password: "user:pass",
      udp: true,
      sni: "peer.example.com",
      "skip-cert-verify": true,
      "client-fingerprint": "firefox",
      "ech-opts": { enable: true },
    });
    expect(
      parseAnyTLS(
        "anytls://query.example.com:8443?auth_str=secret&servername=sni.example.com&clientFingerprint=safari&alpn=h2,,http/1.1&idleSessionCheckInterval=bad&idleSessionTimeout=30&minIdleSession=4&paddingScheme=pad"
      )
    ).toMatchObject({
      name: "AnyTLS-query.example.com:8443",
      password: "secret",
      sni: "sni.example.com",
      alpn: ["h2", "http/1.1"],
      "client-fingerprint": "safari",
      "idle-session-timeout": 30,
      "min-idle-session": 4,
      "padding-scheme": "pad",
    });
    expect(
      parseAnyTLS(
        "anytls://host-token.example.com?auth=secret&udp=1&alpn=,,&idle-session-check-interval=&idleSessionCheckInterval=15"
      )
    ).toMatchObject({
      name: "AnyTLS-host-token.example.com:443",
      server: "host-token.example.com",
      password: "secret",
      udp: true,
      sni: "host-token.example.com",
      "idle-session-check-interval": 15,
    });

    expect(() => parseAnyTLS("anytls://secret@anytls.example.com:443?security=xtls")).toThrow(
      "AnyTLS 不支持 security=xtls"
    );
    expect(() => parseAnyTLS("anytls://secret@anytls.example.com:443?type=tcp&headerType=http")).toThrow(
      "AnyTLS 不支持 headerType=http"
    );
    expect(() => parseAnyTLS("anytls://secret@anytls.example.com:443?pbk=public")).toThrow(
      "AnyTLS 不支持 Reality 参数"
    );
    expect(() => parseAnyTLS("anytls://secret@anytls.example.com:443?serviceName=svc")).toThrow(
      "AnyTLS 不支持传输层参数"
    );
  });

  it("parses Trojan WebSocket, gRPC, ECH, and validation paths", () => {
    const ws = parseTrojan(
      `trojan://pa%3Ass@trojan.example.com:443?type=httpupgrade&host=cdn.example.com&path=/ws%3Fed%3D256&allow-insecure=1&fp=chrome&alpn=h2,http/1.1&ech=${Buffer.from("ech").toString("base64")}#Trojan`
    );
    const grpc = parseTrojan(
      "trojan://secret@grpc.example.com:443?type=grpc&serviceName=svc&mode=gun&authority=authority.example.com#GRPC"
    );

    expect(ws).toMatchObject({
      name: "Trojan",
      password: "pa:ss",
      network: "ws",
      "skip-cert-verify": true,
      "client-fingerprint": "chrome",
      alpn: ["h2", "http/1.1"],
      "ech-opts": { enable: true },
      "ws-opts": {
        path: "/ws",
        headers: { Host: "cdn.example.com" },
        "max-early-data": 256,
        "v2ray-http-upgrade": true,
      },
    });
    expect(grpc).toMatchObject({
      network: "grpc",
      "grpc-opts": {
        "grpc-service-name": "svc",
        _grpcType: "gun",
        _grpcAuthority: "authority.example.com",
      },
    });
    expect(() => parseTrojan("http://bad")).toThrow("无效的 Trojan 链接");
    expect(() => parseTrojan("trojan://@trojan.example.com:443")).toThrow("Trojan 配置缺少必要字段");
    expect(() => parseTrojan("trojan://secret@trojan.example.com:70000")).toThrow("无效的端口号");
  });

  it("parses Trojan transport aliases and conservative TCP fallback", () => {
    expect(
      parseTrojan(
        "trojan://secret@trojan.example.com?ws=true&wspath=/ws&obfsParam=cdn.example.com&allowInsecure=yes&clientFingerprint=firefox&ech=#Alias"
      )
    ).toMatchObject({
      name: "Alias",
      port: 443,
      network: "ws",
      "skip-cert-verify": true,
      "client-fingerprint": "firefox",
      "ech-opts": { enable: true },
      "ws-opts": {
        path: "/ws",
        headers: { Host: "cdn.example.com" },
      },
    });
    expect(parseTrojan("trojan://secret@grpc.example.com:443?type=grpc&path=/fallback")).toMatchObject({
      network: "grpc",
      "grpc-opts": { "grpc-service-name": "fallback" },
    });
    expect(parseTrojan("trojan://secret@tcp.example.com:443?type=kcp")).toMatchObject({
      network: "tcp",
      sni: "tcp.example.com",
    });
  });

  it("parses TUIC token and query-credential variants", () => {
    expect(parseTuic("tuic://token-secret@tuic.example.com:443?token=query-token#Token")).toMatchObject({
      name: "Token",
      type: "tuic",
      server: "tuic.example.com",
      token: "query-token",
    });
    expect(
      parseTuic(
        `tuic://ignored@query.example.com:443?uuid=${UUID}&password=secret&sni=sni.example.com&alpn=h3,h2&congestion-control=bbr&udp-relay-mode=native&request-timeout=5000&heartbeat-interval=9000&max-open-streams=16&max-idle-time=30&reduce-rtt=1&tfo=true&allow-insecure=true&disable-sni=1#Query`
      )
    ).toMatchObject({
      name: "Query",
      uuid: UUID,
      password: "secret",
      sni: "sni.example.com",
      alpn: ["h3", "h2"],
      "congestion-controller": "bbr",
      "udp-relay-mode": "native",
      "request-timeout": 5000,
      "heartbeat-interval": 9000,
      "max-open-streams": 16,
      "max-idle-time": 30,
      "reduce-rtt": true,
      tfo: true,
      "skip-cert-verify": true,
      "disable-sni": true,
    });
    expect(() => parseTuic("http://bad")).toThrow("无效的 TUIC 链接");
    expect(() => parseTuic("tuic://@tuic.example.com:443")).toThrow("TUIC 配置缺少必要字段");
    expect(() => parseTuic(`tuic://${UUID}:secret@tuic.example.com:70000`)).toThrow("无效的端口号");
  });

  it("parses WireGuard aliases, address fields, and optional peer metadata", () => {
    const node = parseWireGuard(
      "wg://private-key@wg.example.com:51820?publicKey=public&presharedkey=psk&address=10.0.0.2/32,[fd00::2]/128&reserved=1,2,3&mtu=1280&udp=0&flag=ignored&keepalive=25#WG"
    );

    expect(node).toMatchObject({
      name: "WG",
      type: "wireguard",
      server: "wg.example.com",
      port: 51820,
      "private-key": "private-key",
      "public-key": "public",
      "pre-shared-key": "psk",
      ip: "10.0.0.2",
      ipv6: "fd00::2",
      reserved: [1, 2, 3],
      mtu: 1280,
      udp: false,
      "persistent-keepalive": 25,
    });
    expect(() => parseWireGuard("http://bad")).toThrow("无效的 WireGuard 链接");
    expect(() => parseWireGuard("wireguard://@wg.example.com:51820")).toThrow("WireGuard 配置缺少必要字段");
    expect(() => parseWireGuard("wireguard://private@wg.example.com:70000")).toThrow("无效的端口号");
  });

  it("parses WireGuard query credentials and ignores invalid optional values", () => {
    const node = parseWireGuard(
      "wireguard://wg-query.example.com?private_key=private&publickey=public&ip=10.0.0.2/32&reserved=1,2&mtu=bad&udp=maybe&extra=value"
    );

    expect(node).toMatchObject({
      name: "WireGuard wg-query.example.com:51820",
      type: "wireguard",
      server: "wg-query.example.com",
      port: 51820,
      "private-key": "private",
      "public-key": "public",
      ip: "10.0.0.2",
      udp: true,
      extra: "value",
    });
    expect(node).not.toHaveProperty("reserved");
    expect(node).not.toHaveProperty("mtu");
  });
});
