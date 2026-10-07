import { describe, expect, it } from "vitest";
import { configToYaml } from "../../generator/yaml";
import type { ClashConfig } from "../../types/config";
import { parseVLESS } from "./vless";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("parseVLESS", () => {
  it("parses HTTP transport with domain fronting and primitive TLS aliases", () => {
    const node = parseVLESS(
      `vless://${UUID}@vless-http.example.com:443?security=tls&type=http&host=front.example.com,alt.example.com&path=/a,/b&method=post&sni=edge.example.com&allow-insecure=1&alpn=h2,http/1.1&packet-encoding=xudp#HTTP`
    );

    expect(node).toMatchObject({
      name: "HTTP",
      type: "vless",
      server: "vless-http.example.com",
      port: 443,
      uuid: UUID,
      tls: true,
      servername: "edge.example.com",
      "skip-cert-verify": true,
      alpn: ["h2", "http/1.1"],
      "packet-encoding": "xudp",
      network: "http",
      "http-opts": {
        method: "POST",
        path: ["/a", "/b"],
        headers: { Host: ["front.example.com", "alt.example.com"] },
      },
    });
  });

  it("parses gRPC and xHTTP transports with extended options", () => {
    const grpc = parseVLESS(
      `vless://${UUID}@grpc.example.com:443?security=tls&type=grpc&serviceName=svc&mode=gun&authority=authority.example.com#GRPC`
    );
    const headers = encodeURIComponent("User-Agent:SubBoost|X-Test:yes");
    const downloadHeaders = encodeURIComponent('{"Accept":"application/octet-stream"}');
    const xhttp = parseVLESS(
      `vless://${UUID}@xhttp.example.com:443?security=tls&type=xhttp&path=/x&host=cdn.example.com&xhttp-mode=packet-up&xhttp-headers=${headers}&no-grpc-header=1&x-padding-bytes=100-200&sc-max-each-post-bytes=2048&max-concurrency=4&download-path=/download&download-host=download.example.com&download-headers=${downloadHeaders}#XHTTP`
    );

    expect(grpc).toMatchObject({
      name: "GRPC",
      network: "grpc",
      "grpc-opts": {
        "grpc-service-name": "svc",
        _grpcType: "gun",
        _grpcAuthority: "authority.example.com",
      },
    });
    expect(xhttp).toMatchObject({
      name: "XHTTP",
      network: "xhttp",
      "xhttp-opts": {
        path: "/x",
        host: "cdn.example.com",
        mode: "packet-up",
        headers: {
          "User-Agent": "SubBoost",
          "X-Test": "yes",
        },
        "no-grpc-header": true,
        "x-padding-bytes": "100-200",
        "sc-max-each-post-bytes": 2048,
        "reuse-settings": {
          "max-concurrency": "4",
        },
        "download-settings": {
          path: "/download",
          host: "download.example.com",
          headers: {
            Accept: "application/octet-stream",
          },
        },
      },
    });

    expect(
      parseVLESS(
        `vless://${UUID}@xhttp-alias.example.com:443?security=tls&type=xhttp&xhttpPath=/alias&xhttpHost=alias.example.com&headers=%7B%22bad%22%3A1%7D&noGrpcHeader=off&scMaxEachPostBytes=bad&maxConnections=8&cMaxReuseTimes=3&hMaxRequestTimes=4&hMaxReusableSecs=30`
      )
    ).toMatchObject({
      network: "xhttp",
      "xhttp-opts": {
        path: "/alias",
        host: "alias.example.com",
        "no-grpc-header": false,
        "reuse-settings": {
          "max-connections": "8",
          "c-max-reuse-times": "3",
          "h-max-request-times": "4",
          "h-max-reusable-secs": "30",
        },
      },
    });
  });

  it("parses Shadowrocket-style encoded authority and ordinary TLS aliases", () => {
    const encoded = Buffer.from(`prefix:${UUID}@shadowrocket.example.com:443`).toString("base64url");
    const node = parseVLESS(
      `vless://${encoded}?obfs=websocket&tls=1&xtls=2&obfsParam=cdn.example.com&path=/ws%3Fed%3D512#Shadowrocket`
    );

    expect(node).toMatchObject({
      name: "Shadowrocket",
      type: "vless",
      server: "shadowrocket.example.com",
      uuid: UUID,
      tls: true,
      flow: "xtls-rprx-vision",
      "client-fingerprint": "chrome",
      network: "ws",
      "ws-opts": {
        path: "/ws",
        headers: { Host: "cdn.example.com" },
        "early-data-header-name": "Sec-WebSocket-Protocol",
        "max-early-data": 512,
      },
    });
    expect(node).not.toHaveProperty("reality-opts");

    const encodedWithoutPrefix = Buffer.from(`${UUID}@shadow-simple.example.com:443`).toString("base64url");
    expect(parseVLESS(`vless://${encodedWithoutPrefix}?obfs=websocket&tls=1&xtls=1&tls-verification=false&remark=SimpleSR`)).toMatchObject({
      name: "SimpleSR",
      server: "shadow-simple.example.com",
      uuid: UUID,
      flow: "xtls-rprx-direct",
      "client-fingerprint": "chrome",
      "skip-cert-verify": true,
      network: "ws",
    });
  });

  it("parses Shadowrocket ordinary TLS with compound ECH through generated YAML", () => {
    const encoded = Buffer.from(`:${UUID}@vless-ech.example.com:443`).toString("base64url");
    const ech = encodeURIComponent("cloudflare-ech.com+https://203.0.113.53/dns-query");
    const obfsParam = encodeURIComponent(
      JSON.stringify({
        "": {
          xPaddingHeader: "X-Request-Signature",
          xPaddingPlacement: "queryInHeader",
          xPaddingObfsMode: true,
          xPaddingKey: "_tk",
          xPaddingMethod: "tokenish",
        },
        hOsT: "cdn.example.com",
        "X-Test": "yes",
        Numeric: 1,
        Enabled: true,
      })
    );
    const node = parseVLESS(
      `vless://${encoded}?obfs=xhttp&tls=1&peer=front.example.com&path=%2Fxhttp&obfsParam=${obfsParam}&ech=${ech}#ShadowrocketECH`
    );

    expect(node).toMatchObject({
      name: "ShadowrocketECH",
      type: "vless",
      server: "vless-ech.example.com",
      port: 443,
      uuid: UUID,
      tls: true,
      servername: "front.example.com",
      "client-fingerprint": "chrome",
      network: "xhttp",
      "xhttp-opts": {
        path: "/xhttp",
        host: "cdn.example.com",
        headers: {
          "X-Test": "yes",
        },
      },
      "ech-opts": {
        enable: true,
        "query-server-name": "cloudflare-ech.com",
      },
    });
    expect(node).not.toHaveProperty("reality-opts");
    expect(Object.prototype.hasOwnProperty.call(node["xhttp-opts"] || {}, "")).toBe(false);
    expect(node["xhttp-opts"]?.headers).not.toHaveProperty("Numeric");
    expect(node["xhttp-opts"]?.headers).not.toHaveProperty("Enabled");

    const generated = configToYaml({
      proxies: [node],
      "proxy-groups": [],
      "rule-providers": {},
      rules: [],
    } as unknown as ClashConfig);
    expect(generated).toContain("ech-opts: {enable: true, query-server-name: cloudflare-ech.com}");
    expect(generated).not.toContain("config: cloudflare-ech.com+");
    expect(generated).not.toContain("reality-opts");
    expect(generated).not.toContain("xPaddingHeader");
    expect(generated).not.toContain("Numeric");
  });

  it("keeps explicit xHTTP host and headers ahead of Shadowrocket obfsParam fallbacks", () => {
    const encoded = Buffer.from(`${UUID}@xhttp-precedence.example.com:443`).toString("base64url");
    const obfsParam = encodeURIComponent(
      JSON.stringify({ Host: "fallback.example.com", "X-Test": "fallback", "X-Fallback": "yes" })
    );
    const explicitHeaders = encodeURIComponent(JSON.stringify({ "X-Test": "explicit", "X-Explicit": "yes" }));

    expect(
      parseVLESS(
        `vless://${encoded}?obfs=xhttp&tls=1&xhttpHost=explicit.example.com&xhttpHeaders=${explicitHeaders}&obfsParam=${obfsParam}#XHTTPPrecedence`
      )
    ).toMatchObject({
      "xhttp-opts": {
        host: "explicit.example.com",
        headers: {
          "X-Test": "explicit",
          "X-Fallback": "yes",
          "X-Explicit": "yes",
        },
      },
    });

    expect(
      parseVLESS(`vless://${encoded}?obfs=xhttp&tls=1&obfsParam=legacy.example.com#XHTTPLegacy`)
    ).toMatchObject({
      "xhttp-opts": {
        host: "legacy.example.com",
      },
    });

    const duplicateHostObfsParam = encodeURIComponent(
      JSON.stringify({ Host: "first.example.com", host: "second.example.com" })
    );
    expect(
      parseVLESS(
        `vless://${encoded}?obfs=xhttp&tls=1&obfsParam=${duplicateHostObfsParam}#XHTTPDuplicateHost`
      )
    ).toMatchObject({
      "xhttp-opts": {
        host: "first.example.com",
      },
    });
  });

  it("infers implicit Shadowrocket Reality only from a public key", () => {
    const encoded = Buffer.from(`${UUID}@shadow-reality.example.com:443`).toString("base64url");
    const publicKey = "A".repeat(43);

    expect(parseVLESS(`vless://${encoded}?tls=1&pbk=${publicKey}#ImplicitReality`)).toMatchObject({
      name: "ImplicitReality",
      tls: true,
      "client-fingerprint": "chrome",
      "reality-opts": {
        "public-key": publicKey,
      },
    });
    expect(() =>
      parseVLESS(
        `vless://${encoded}?tls=1&pbk=${publicKey}&ech=${encodeURIComponent("cloudflare-ech.com")}#BadRealityECH`
      )
    ).toThrow("VLESS 启用 ECH 需要 security=tls");

    const explicitTls = parseVLESS(
      `vless://${encoded}?security=tls&tls=1&pbk=${publicKey}&ech=${encodeURIComponent("cloudflare-ech.com")}#ExplicitTLS`
    );
    expect(explicitTls).toMatchObject({
      tls: true,
      "ech-opts": {
        enable: true,
        "query-server-name": "cloudflare-ech.com",
      },
    });
    expect(explicitTls).not.toHaveProperty("reality-opts");
    expect(explicitTls).not.toHaveProperty("client-fingerprint");
  });

  it("parses TCP, H2, HTTP Upgrade, and Reality detail variants", () => {
    const publicKey = "A".repeat(43);

    expect(
      parseVLESS(`vless://${UUID}@tcp.example.com:80?type=none&udp=0&encryption=none&remarks=TCP&pcs=pcs&pqv=pqv`)
    ).toMatchObject({
      name: "TCP",
      type: "vless",
      server: "tcp.example.com",
      port: 80,
      uuid: UUID,
      encryption: "none",
      network: "tcp",
      pcs: "pcs",
      pqv: "pqv",
    });

    expect(
      parseVLESS(`vless://${UUID}@h2.example.com:443?h2=1&security=tls&host=h2-a.example.com,h2-b.example.com&path=/h2&sni=front.example.com#H2`)
    ).toMatchObject({
      name: "H2",
      network: "h2",
      tls: true,
      servername: "front.example.com",
      "h2-opts": {
        host: ["h2-a.example.com", "h2-b.example.com"],
        path: "/h2",
      },
    });

    expect(
      parseVLESS(`vless://${UUID}@upgrade.example.com:443?type=httpupgrade&security=tls&host=cdn.example.com&path=/upgrade#Upgrade`)
    ).toMatchObject({
      name: "Upgrade",
      network: "ws",
      "ws-opts": {
        path: "/upgrade",
        headers: { Host: "cdn.example.com" },
        "v2ray-http-upgrade": true,
        "v2ray-http-upgrade-fast-open": true,
      },
    });

    expect(
      parseVLESS(
        `vless://${UUID}@reality.example.com:443?security=reality&pbk=${publicKey}&sid=0x7250&spx=%2Fspider&fp=random#Reality`
      )
    ).toMatchObject({
      name: "Reality",
      tls: true,
      "client-fingerprint": "random",
      "reality-opts": {
        "public-key": publicKey,
        "short-id": "7250",
        "_spider-x": "/spider",
      },
    });

    expect(
      parseVLESS(`vless://${UUID}@fronted.example.com:443?security=tls&headerType=http&sni=edge.example.com&path=/front`)
    ).toMatchObject({
      network: "http",
      "http-opts": {
        method: "GET",
        path: ["/front"],
        headers: { Host: ["edge.example.com"] },
      },
    });

    expect(parseVLESS(`vless://${UUID}@ech.example.com:443?security=tls&ech=#ECH`)).toMatchObject({
      name: "ECH",
      tls: true,
      "ech-opts": { enable: true },
    });

    expect(parseVLESS(`vless://${UUID}@grpc-path.example.com:443?security=tls&type=grpc&path=/fallback#GRPCPath`)).toMatchObject({
      name: "GRPCPath",
      network: "grpc",
      "grpc-opts": {
        "grpc-service-name": "fallback",
      },
    });
  });

  it("parses Shadowrocket JSON headers and validates malformed VLESS links", () => {
    const encoded = Buffer.from(`prefix:${UUID}@sr-json.example.com:443`).toString("base64url");
    const headers = encodeURIComponent('{"Host":"json.example.com","User-Agent":"UA"}');

    expect(parseVLESS(`vless://${encoded}?obfs=websocket&obfsParam=${headers}&path=/ws#SRJSON`)).toMatchObject({
      name: "SRJSON",
      server: "sr-json.example.com",
      network: "ws",
      "ws-opts": {
        path: "/ws",
        headers: {
          Host: "json.example.com",
          "User-Agent": "UA",
        },
      },
    });

    expect(() => parseVLESS("http://bad")).toThrow("无效的 VLESS 链接");
    expect(() => parseVLESS("vless://@missing.example.com:443")).toThrow("VLESS 配置缺少必要字段");
    expect(() => parseVLESS(`vless://${UUID}@bad.example.com:70000`)).toThrow("无效的端口号");
  });

  it("parses minimal transport variants without optional headers", () => {
    expect(parseVLESS(`vless://${UUID}@plain-ws.example.com:443?type=websocket&alpn=,,&path=/ws#PlainWS`))
      .toMatchObject({
        name: "PlainWS",
        network: "ws",
        "ws-opts": {
          path: "/ws",
          headers: undefined,
        },
      });
    expect(parseVLESS(`vless://${UUID}@http-default.example.com:80?type=http`)).toMatchObject({
      name: "VLESS 节点",
      network: "http",
      "http-opts": {
        method: "GET",
        path: ["/"],
        headers: undefined,
      },
    });
    expect(parseVLESS(`vless://${UUID}@h2-front.example.com:443?security=tls&type=h2&sni=front.example.com`))
      .toMatchObject({
        network: "h2",
        "h2-opts": {
          host: ["front.example.com"],
          path: "/",
        },
      });
    expect(parseVLESS(`vless://${UUID}@h2-default.example.com:443?security=tls&type=h2#H2Default`))
      .toMatchObject({
        name: "H2Default",
        network: "h2",
        "h2-opts": {
          host: undefined,
          path: "/",
        },
      });
    expect(parseVLESS(`vless://${UUID}@reality-min.example.com:443?security=reality`)).toMatchObject({
      tls: true,
      network: "tcp",
      "client-fingerprint": "chrome",
    });
  });

  it("parses Shadowrocket empty TLS and ignores malformed JSON header maps", () => {
    const encoded = Buffer.from(`${UUID}@sr-empty.example.com:443`).toString("base64url");
    const headers = encodeURIComponent('{"Host":{}}');

    const node = parseVLESS(`vless://${encoded}?obfs=websocket&tls=0&xtls=0&obfsParam=${headers}&path=/ws`);

    expect(node).toMatchObject({
      server: "sr-empty.example.com",
      tls: false,
      network: "ws",
      "ws-opts": {
        path: "/ws",
        headers: {
          Host: '{"Host":{}}',
        },
      },
    });
    expect(node).not.toHaveProperty("flow");
  });

  it("keeps VLESS authority and xHTTP edge branches explicit", () => {
    expect(parseVLESS(`vless://${UUID}@[2001:db8::1]:443?security=tls&type=ws&host=ipv6.example.com#IPv6`))
      .toMatchObject({
        name: "IPv6",
        server: "2001:db8::1",
        port: 443,
        network: "ws",
        "ws-opts": {
          path: "/",
          headers: { Host: "ipv6.example.com" },
        },
      });

    const encoded = Buffer.from(`prefix:${UUID}@sr-flow.example.com:443`).toString("base64url");
    expect(
      parseVLESS(
        `vless://${encoded}?obfs=websocket&tls=yes&flow=xtls-rprx-vision&obfsParam=NoColon%7C%3Abad%7CHost%3Acdn.example.com&path=%2F#Flow`
      )
    ).toMatchObject({
      name: "Flow",
      server: "sr-flow.example.com",
      flow: "xtls-rprx-vision",
      network: "ws",
      "ws-opts": {
        path: "/",
        headers: { Host: "NoColon|:bad|Host:cdn.example.com" },
      },
    });

    expect(
      parseVLESS(
        `vless://${UUID}@xhttp-fallback.example.com:443?security=tls&type=xhttp&path=&host=&headers=NoColon%7C%3Aempty%7CGood%3Ayes&no-grpc-header=maybe&download-headers=%7B%22bad%22%3A1%7D#XFallback`
      )
    ).toMatchObject({
      name: "XFallback",
      network: "xhttp",
      "xhttp-opts": {
        path: "/",
        headers: { Good: "yes" },
      },
    });
  });

  it("handles VLESS authority probes and empty Shadowrocket websocket options", () => {
    const encoded = Buffer.from(`${UUID}@sr-empty-options.example.com:443`).toString("base64url");

    expect(parseVLESS(`vless://${UUID}@slash-authority.example.com:443/?type=ws#Slash`)).toMatchObject({
      name: "Slash",
      server: "slash-authority.example.com",
      network: "ws",
    });
    expect(parseVLESS(`vless://${encoded}?obfs=websocket&obfsParam=%20&path=%3Fed%3D64#EmptyOptions`))
      .toMatchObject({
        name: "EmptyOptions",
        server: "sr-empty-options.example.com",
        network: "ws",
        "ws-opts": {
          path: "/",
          headers: undefined,
          "early-data-header-name": "Sec-WebSocket-Protocol",
          "max-early-data": 64,
        },
      });

    expect(() => parseVLESS(`vless://${UUID}@missing-host-port.example.com?x=1`)).toThrow();
    expect(() => parseVLESS(`vless://${UUID}@empty-host-port.example.com:?x=1`)).toThrow();
    expect(() => parseVLESS(`vless://${UUID}@bad-host-port.example.com:abc?x=1`)).toThrow();
    expect(() => parseVLESS(`vless://${UUID}@[2001:db8::1?x=1`)).toThrow();
    expect(() => parseVLESS(`vless://${UUID}@?x=1`)).toThrow();
  });

  it("rejects malformed Shadowrocket-style VLESS probes before normal parsing", () => {
    const noQuery = Buffer.from(`${UUID}@shadow-no-query.example.com:443`).toString("base64url");

    expect(() => parseVLESS(`vless://${noQuery}`)).toThrow("VLESS 配置缺少必要字段");
    expect(() => parseVLESS(`vless://${UUID}@[2001:db8::1]?security=tls`)).toThrow("VLESS 配置缺少必要字段");
  });

  it("rejects unsupported transports and ECH without plain TLS", () => {
    expect(() => parseVLESS(`vless://${UUID}@bad.example.com:443?type=kcp#Bad`)).toThrow("不支持的 VLESS 传输层");
    expect(() => parseVLESS(`vless://${UUID}@bad.example.com:443?security=reality&ech=config#Bad`)).toThrow(
      "VLESS 启用 ECH 需要 security=tls"
    );
  });
});
