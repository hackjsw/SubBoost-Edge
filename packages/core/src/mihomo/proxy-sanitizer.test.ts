import { describe, expect, it } from "vitest";
import {
  isMihomoSupportedProxyNode,
  isStandardBase64String,
  normalizeMihomoRealityPublicKey,
  normalizeMihomoVlessForGeneration,
  sanitizeMihomoProxyNode,
} from "./proxy-sanitizer";

const REALITY_PUBLIC_KEY = "A".repeat(43);
const WIREGUARD_KEY = `${"A".repeat(43)}=`;
const SSH_HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA== comment";
const SSH_FINGERPRINT = `SHA256:${"A".repeat(43)}`;
const PRIVATE_KEY = ["-----BEGIN OPENSSH ", "PRIVATE ", "KEY-----\nabc\n-----END OPENSSH ", "PRIVATE ", "KEY-----"].join("");

describe("Mihomo proxy sanitizer", () => {
  it("normalizes common VLESS Reality fields before YAML generation", () => {
    const node = sanitizeMihomoProxyNode({
      name: "Reality",
      type: "vless",
      server: "reality.example.com",
      port: 443,
      uuid: "11111111-1111-1111-1111-111111111111",
      fingerprint: "Firefox",
      udp: "yes",
      alpn: "h2,http/1.1",
      network: "ws",
      "reality-opts": {
        "public-key": REALITY_PUBLIC_KEY,
        "short-id": "0x7250",
      },
      "ws-opts": {
        path: "/ws?a=1&ed=1024&b=2",
      },
    });

    expect(node).toMatchObject({
      type: "vless",
      tls: true,
      udp: true,
      "client-fingerprint": "firefox",
      alpn: ["h2", "http/1.1"],
      "reality-opts": {
        "public-key": REALITY_PUBLIC_KEY,
        "short-id": "7250",
      },
      "ws-opts": {
        path: "/ws?a=1&b=2",
        "early-data-header-name": "Sec-WebSocket-Protocol",
        "max-early-data": 1024,
      },
    });
    expect(node).not.toHaveProperty("fingerprint");
  });

  it("keeps xhttp download settings aligned with the main Reality settings", () => {
    const node = normalizeMihomoVlessForGeneration({
      name: "XHTTP",
      type: "vless",
      network: "xhttp",
      "reality-opts": {
        "public-key": REALITY_PUBLIC_KEY,
      },
      "xhttp-opts": {
        mode: "auto",
        "download-settings": {
          "ech-opts": {
            enable: "yes",
            config: Buffer.from("ech").toString("base64"),
          },
        },
      },
    });

    expect(node).toMatchObject({
      tls: true,
      "client-fingerprint": "chrome",
      "xhttp-opts": {
        mode: "auto",
        "download-settings": {
          "ech-opts": {
            enable: true,
            config: Buffer.from("ech").toString("base64"),
          },
          "reality-opts": {
            "public-key": "",
          },
        },
      },
    });
  });

  it("rejects unsupported or invalid nodes before they reach generated YAML", () => {
    expect(isMihomoSupportedProxyNode({ type: "socks4", name: "old" })).toBe(false);
    expect(isMihomoSupportedProxyNode({ type: "vless", uuid: "u", "reality-opts": { "public-key": "bad" } })).toBe(false);
    expect(isMihomoSupportedProxyNode({ type: "ssh", name: "ssh", server: "ssh.example.com", port: 22 })).toBe(false);
    expect(
      isMihomoSupportedProxyNode({
        type: "wireguard",
        name: "wg",
        server: "wg.example.com",
        port: 51820,
        "private-key": WIREGUARD_KEY,
      })
    ).toBe(true);
  });

  it("normalizes protocol-specific scalar fields without accepting malformed values", () => {
    expect(isStandardBase64String(Buffer.from("hello").toString("base64"))).toBe(true);
    expect(isStandardBase64String("not base64")).toBe(false);
    expect(normalizeMihomoRealityPublicKey(REALITY_PUBLIC_KEY)).toBe(REALITY_PUBLIC_KEY);
    expect(normalizeMihomoRealityPublicKey("short")).toBeNull();

    const https = sanitizeMihomoProxyNode({
      name: "HTTPS",
      type: "https",
      server: "https.example.com",
      port: 443,
      fingerprint: "sha256:AA:BB",
      "skip-cert-verify": "no",
    });

    expect(https).toMatchObject({
      type: "http",
      tls: true,
      "skip-cert-verify": false,
    });
    expect(https).not.toHaveProperty("fingerprint");
  });

  it("cleans WireGuard, SSH, ECH, and VLESS encryption fields conservatively", () => {
    const wireguard = sanitizeMihomoProxyNode({
      name: "WG",
      type: "wireguard",
      server: "wg.example.com",
      port: 51820,
      "private-key": WIREGUARD_KEY,
      "public-key": "bad",
      "pre-shared-key": WIREGUARD_KEY,
      reserved: "1,2,3",
    });
    const ssh = sanitizeMihomoProxyNode({
      name: "SSH",
      type: "ssh",
      server: "ssh.example.com",
      port: 22,
      "private-key": PRIVATE_KEY,
      "private-key-passphrase": "secret",
      "host-key": [SSH_HOST_KEY, "bad"],
      "server-fingerprint": SSH_FINGERPRINT,
    });
    const vless = sanitizeMihomoProxyNode({
      name: "VLESS",
      type: "vless",
      server: "vless.example.com",
      port: 443,
      uuid: "11111111-1111-4111-8111-111111111111",
      encryption: "mlkem768x25519plus.native.1rtt.bad token",
      "ech-opts": {
        enable: "yes",
        config: "not-base64",
        "query-server-name": "ech.example.com",
        _internal: "drop",
      },
    });

    expect(wireguard).toMatchObject({
      "private-key": WIREGUARD_KEY,
      "pre-shared-key": WIREGUARD_KEY,
      reserved: [1, 2, 3],
    });
    expect(wireguard).not.toHaveProperty("public-key");
    expect(ssh).toMatchObject({
      "private-key": PRIVATE_KEY,
      "host-key": [SSH_HOST_KEY],
      "server-fingerprint": SSH_FINGERPRINT,
    });
    expect(vless).toMatchObject({
      "ech-opts": {
        enable: true,
        "query-server-name": "ech.example.com",
      },
    });
    expect(vless).not.toHaveProperty("encryption");
    expect(vless["ech-opts"]).not.toHaveProperty("config");
    expect(vless["ech-opts"]).not.toHaveProperty("_internal");
  });

  it("marks invalid generation-only combinations as unsupported", () => {
    expect(
      isMihomoSupportedProxyNode({
        name: "SS",
        type: "ss",
        server: "ss.example.com",
        port: 8388,
        cipher: "aes-128-gcm",
        password: "secret",
        plugin: "v2ray-plugin",
        "plugin-opts": { mode: "quic" },
      })
    ).toBe(false);
    expect(
      isMihomoSupportedProxyNode({
        name: "SS",
        type: "ss",
        server: "ss.example.com",
        port: 8388,
        cipher: "aes-128-gcm",
        password: "secret",
        plugin: "v2ray-plugin",
        "plugin-opts": { mode: "websocket" },
      })
    ).toBe(true);

    const invalidXhttp = normalizeMihomoVlessForGeneration({
      name: "XHTTP",
      type: "vless",
      network: "xhttp",
      uuid: "11111111-1111-4111-8111-111111111111",
      "xhttp-opts": {
        mode: "stream-one",
        "download-settings": {
          path: "/download",
        },
      },
    });

    expect(isMihomoSupportedProxyNode(invalidXhttp)).toBe(false);
    expect(isMihomoSupportedProxyNode({ name: "vmess", type: "vmess" })).toBe(false);
    expect(isMihomoSupportedProxyNode(null)).toBe(false);
  });

  it("drops invalid optional fields instead of emitting malformed Mihomo YAML", () => {
    const invalidSsh = sanitizeMihomoProxyNode({
      name: "SSH",
      type: "ssh",
      server: "ssh.example.com",
      port: 22,
      "private-key": "not a pem",
      "private-key-passphrase": "secret",
      "host-key": ["bad"],
      "server-fingerprint": "bad",
    });
    const httpsFingerprint = sanitizeMihomoProxyNode({
      name: "HTTPS",
      type: "https",
      server: "https.example.com",
      port: 443,
      fingerprint: "sha256=" + "A".repeat(64),
      alpn: [" h2 ", "", "http/1.1"],
      "ws-opts": {
        path: "/up?ed=1024",
        "v2ray-http-upgrade": "yes",
        "early-data-header-name": "drop",
        "max-early-data": 1024,
        _internal: "drop",
      },
    });
    const invalidDownloadReality = normalizeMihomoVlessForGeneration({
      name: "XHTTP",
      type: "vless",
      uuid: "11111111-1111-4111-8111-111111111111",
      network: "xhttp",
      "xhttp-opts": {
        "download-settings": {
          "reality-opts": {},
        },
      },
    });
    const nonObjectXhttp = normalizeMihomoVlessForGeneration({
      name: "XHTTP",
      type: "vless",
      uuid: "11111111-1111-4111-8111-111111111111",
      network: "xhttp",
      "xhttp-opts": "bad",
      encryption: "none",
    });

    expect(invalidSsh).not.toHaveProperty("private-key");
    expect(invalidSsh).not.toHaveProperty("private-key-passphrase");
    expect(invalidSsh).not.toHaveProperty("host-key");
    expect(invalidSsh).not.toHaveProperty("server-fingerprint");
    expect(httpsFingerprint).toMatchObject({
      type: "http",
      tls: true,
      fingerprint: "a".repeat(64),
      alpn: ["h2", "http/1.1"],
      "ws-opts": {
        path: "/up",
        "v2ray-http-upgrade": true,
      },
    });
    expect(httpsFingerprint["ws-opts"]).not.toHaveProperty("early-data-header-name");
    expect(httpsFingerprint["ws-opts"]).not.toHaveProperty("max-early-data");
    expect(invalidDownloadReality).toHaveProperty("_subboost-invalid-mihomo-node", true);
    expect(nonObjectXhttp).toMatchObject({ encryption: "none" });
    expect(nonObjectXhttp).not.toHaveProperty("xhttp-opts");
  });

  it("normalizes scalar edge cases while preserving explicit safe values", () => {
    expect(sanitizeMihomoProxyNode("raw" as never)).toBe("raw");

    const node = sanitizeMihomoProxyNode({
      name: "Scalar",
      type: "vmess",
      server: "vmess.example.com",
      port: 443,
      uuid: "11111111-1111-4111-8111-111111111111",
      udp: 1,
      tls: 0,
      tfo: 2,
      mptcp: "maybe",
      reuse: "off",
      "udp-over-tcp": "on",
      alpn: [" h3 ", 443, ""],
      "ech-opts": {
        enable: "maybe",
        config: Buffer.from("ech").toString("base64"),
        extra: "keep",
      },
      "ws-opts": "/not-object",
      fingerprint: "Safari",
    });

    expect(node).toMatchObject({
      udp: true,
      tls: false,
      reuse: false,
      "udp-over-tcp": true,
      alpn: ["h3"],
      "client-fingerprint": "safari",
      "ech-opts": {
        config: Buffer.from("ech").toString("base64"),
        extra: "keep",
      },
    });
    expect(node).not.toHaveProperty("tfo");
    expect(node).not.toHaveProperty("mptcp");
    expect(node).not.toHaveProperty("ws-opts");
    expect(node).not.toHaveProperty("fingerprint");
  });

  it("removes empty optional containers and keeps explicit HTTPS TLS opt-out", () => {
    const https = sanitizeMihomoProxyNode({
      name: "HTTPS",
      type: "https",
      server: "https.example.com",
      port: 443,
      tls: false,
      alpn: "",
      "ech-opts": {},
      "ws-opts": {
        path: "/ws?ed=2048",
        "early-data-header-name": "Existing",
      },
      fingerprint: "sha256 fingerprint = " + "B".repeat(64),
    });
    const ss = sanitizeMihomoProxyNode({
      name: "SS",
      type: "ss",
      server: "ss.example.com",
      port: 8388,
      cipher: "aes-128-gcm",
      password: "secret",
      fingerprint: "Chrome",
    });

    expect(https).toMatchObject({
      type: "http",
      tls: false,
      fingerprint: "b".repeat(64),
      "ws-opts": {
        path: "/ws",
        "early-data-header-name": "Existing",
      },
    });
    expect(https).not.toHaveProperty("alpn");
    expect(https).not.toHaveProperty("ech-opts");
    expect(https["ws-opts"]).not.toHaveProperty("max-early-data");
    expect(ss).not.toHaveProperty("fingerprint");
    expect(ss).not.toHaveProperty("client-fingerprint");
  });

  it("checks protocol-specific support boundaries before generation", () => {
    expect(isMihomoSupportedProxyNode({ type: "", name: "empty" })).toBe(false);
    expect(
      isMihomoSupportedProxyNode({
        type: "wireguard",
        name: "WG",
        server: "wg.example.com",
        port: 51820,
        "private-key": WIREGUARD_KEY,
        "public-key": "bad",
      })
    ).toBe(false);
    expect(
      isMihomoSupportedProxyNode({
        type: "ssh",
        name: "SSH",
        server: "ssh.example.com",
        port: 22,
        password: "secret",
      })
    ).toBe(true);
    expect(
      isMihomoSupportedProxyNode({
        type: "ss",
        name: "SS",
        server: "ss.example.com",
        port: 8388,
        cipher: "aes-128-gcm",
        password: "secret",
        plugin: "xray-plugin",
        "plugin-opts": { mode: "ws" },
      })
    ).toBe(true);
  });

  it("keeps valid VLESS generation-only xhttp settings", () => {
    const passthrough = { type: "http", name: "HTTP" };
    const xhttp = normalizeMihomoVlessForGeneration({
      name: "XHTTP",
      type: "vless",
      uuid: "11111111-1111-4111-8111-111111111111",
      network: "xhttp",
      "reality-opts": {
        "public-key": REALITY_PUBLIC_KEY,
        "short-id": "not-hex",
      },
      "xhttp-opts": {
        mode: "packet-up",
        "ech-opts": {},
        "download-settings": {
          "ech-opts": {},
          "reality-opts": {
            "public-key": REALITY_PUBLIC_KEY,
            "short-id": "0x7250",
          },
        },
      },
    });
    const vless = sanitizeMihomoProxyNode({
      name: "VLESS",
      type: "vless",
      server: "vless.example.com",
      port: 443,
      uuid: "11111111-1111-4111-8111-111111111111",
      encryption: "mlkem768x25519plus.native.1rtt.valid_token",
    });
    const legacyEncryption = sanitizeMihomoProxyNode({
      name: "VLESS",
      type: "vless",
      server: "vless.example.com",
      port: 443,
      uuid: "11111111-1111-4111-8111-111111111111",
      encryption: "legacy",
    });

    expect(normalizeMihomoVlessForGeneration(passthrough)).toBe(passthrough);
    expect(xhttp).toMatchObject({
      tls: true,
      "client-fingerprint": "chrome",
      "reality-opts": {
        "public-key": REALITY_PUBLIC_KEY,
      },
      "xhttp-opts": {
        mode: "packet-up",
        "download-settings": {
          "reality-opts": {
            "public-key": REALITY_PUBLIC_KEY,
            "short-id": "7250",
          },
        },
      },
    });
    expect(xhttp["reality-opts"]).not.toHaveProperty("short-id");
    expect(xhttp["xhttp-opts"]).not.toHaveProperty("ech-opts");
    expect((xhttp["xhttp-opts"] as Record<string, unknown>)["download-settings"]).not.toHaveProperty("ech-opts");
    expect(vless).toHaveProperty("encryption", "mlkem768x25519plus.native.1rtt.valid_token");
    expect(legacyEncryption).toHaveProperty("encryption", "legacy");
  });

  it("covers remaining conservative cleanup edges", () => {
    const upgradedWs = sanitizeMihomoProxyNode({
      name: "VMess",
      type: "vmess",
      server: "vmess.example.com",
      port: 443,
      uuid: "11111111-1111-4111-8111-111111111111",
      alpn: "h2|http/1.1",
      "ws-opts": {
        path: "/upgrade?ed=1024",
        "v2ray-http-upgrade": "true",
        "early-data-header-name": "drop",
        "max-early-data": 1024,
        "_v2ray-http-upgrade-ed": true,
      },
    });
    const invalidReserved = sanitizeMihomoProxyNode({
      name: "WG",
      type: "wireguard",
      server: "wg.example.com",
      port: 51820,
      "private-key": WIREGUARD_KEY,
      reserved: [1, 2, 999],
    });
    const streamOneWithoutDownload = normalizeMihomoVlessForGeneration({
      name: "XHTTP",
      type: "vless",
      uuid: "11111111-1111-4111-8111-111111111111",
      network: "xhttp",
      "xhttp-opts": {
        mode: "stream-one",
      },
    });

    expect(isStandardBase64String("")).toBe(false);
    expect(normalizeMihomoRealityPublicKey(1)).toBeNull();
    expect(isMihomoSupportedProxyNode({ type: "vless", uuid: "u", "_subboost-invalid-mihomo-node": true })).toBe(false);
    expect(
      isMihomoSupportedProxyNode({
        type: "wireguard",
        name: "WG",
        server: "wg.example.com",
        port: 51820,
        "private-key": WIREGUARD_KEY,
        "pre-shared-key": "bad",
      })
    ).toBe(false);
    expect(upgradedWs).toMatchObject({
      alpn: ["h2", "http/1.1"],
      "ws-opts": {
        path: "/upgrade",
        "v2ray-http-upgrade": true,
      },
    });
    expect(upgradedWs["ws-opts"]).not.toHaveProperty("early-data-header-name");
    expect(upgradedWs["ws-opts"]).not.toHaveProperty("max-early-data");
    expect(upgradedWs["ws-opts"]).not.toHaveProperty("_v2ray-http-upgrade-ed");
    expect(invalidReserved).not.toHaveProperty("reserved");
    expect(streamOneWithoutDownload).toMatchObject({
      "xhttp-opts": {
        mode: "stream-one",
      },
    });
  });

  it("drops private Reality fields while preserving ML-KEM support", () => {
    const node = normalizeMihomoVlessForGeneration({
      name: "LAX",
      type: "vless",
      server: "lax.example.com",
      port: 443,
      uuid: "11111111-1111-4111-8111-111111111111",
      "reality-opts": {
        "public-key": REALITY_PUBLIC_KEY,
        "support-x25519mlkem768": true,
        "_spider-x": "/ba3d46cfbf4c9a7",
      },
    });

    expect(node["reality-opts"]).toMatchObject({
      "public-key": REALITY_PUBLIC_KEY,
      "support-x25519mlkem768": true,
    });
    expect(node["reality-opts"]).not.toHaveProperty("_spider-x");
  });

  it("covers sanitizer boundary aliases and optional protocol fallbacks", () => {
    const ecdsaSsh = sanitizeMihomoProxyNode({
      name: "SSH",
      type: "ssh",
      server: "ssh.example.com",
      port: 22,
      password: "secret",
      "host-key": [
        "ssh-ecdsa-nistp256 AAAAC3NzaC1lZDI1NTE5AAAAIA==",
        "ssh-ecdsa-!bad AAAAC3NzaC1lZDI1NTE5AAAAIA==",
        "ssh-rsa bad!token",
      ],
    });
    const certless = sanitizeMihomoProxyNode({
      name: "HTTP",
      type: "http",
      server: "http.example.com",
      port: 80,
      fingerprint: 1,
    });
    const clientFingerprintAlreadySet = sanitizeMihomoProxyNode({
      name: "Trojan",
      type: "trojan",
      server: "trojan.example.com",
      port: 443,
      password: "secret",
      fingerprint: "Chrome",
      "client-fingerprint": "safari",
    });
    const wireguardReservedArray = sanitizeMihomoProxyNode({
      name: "WG",
      type: "wireguard",
      server: "wg.example.com",
      port: 51820,
      "private-key": WIREGUARD_KEY,
      reserved: [1, "2", 3],
    });
    const xhttpNoReality = normalizeMihomoVlessForGeneration({
      name: "XHTTP",
      type: "vless",
      uuid: "11111111-1111-4111-8111-111111111111",
      network: "xhttp",
      "xhttp-opts": {
        "download-settings": {
          "ech-opts": {
            enable: false,
            config: Buffer.from("ech").toString("base64"),
            "query-server-name": " ech.example.com ",
          },
        },
      },
    });

    expect(ecdsaSsh).toMatchObject({
      "host-key": ["ssh-ecdsa-nistp256 AAAAC3NzaC1lZDI1NTE5AAAAIA=="],
    });
    expect(certless).not.toHaveProperty("fingerprint");
    expect(clientFingerprintAlreadySet).toMatchObject({ "client-fingerprint": "safari" });
    expect(clientFingerprintAlreadySet).not.toHaveProperty("fingerprint");
    expect(wireguardReservedArray).toHaveProperty("reserved", [1, 2, 3]);
    expect(xhttpNoReality).toMatchObject({
      "xhttp-opts": {
        "download-settings": {
          "ech-opts": {
            enable: false,
            config: Buffer.from("ech").toString("base64"),
            "query-server-name": "ech.example.com",
          },
        },
      },
    });
    expect(
      isMihomoSupportedProxyNode({
        type: "trojan",
        name: "Trojan",
        server: "trojan.example.com",
        port: 443,
        password: "secret",
      })
    ).toBe(true);
    expect(
      isMihomoSupportedProxyNode({
        type: "ss",
        name: "SS",
        server: "ss.example.com",
        port: 8388,
        cipher: "aes-128-gcm",
        password: "secret",
        plugin: "v2ray-plugin",
      })
    ).toBe(true);
  });

  it("rejects explicit malformed optional transport fields", () => {
    const ssh = sanitizeMihomoProxyNode({
      name: "SSH",
      type: "ssh",
      server: "ssh.example.com",
      port: 22,
      password: "secret",
      "host-key": [
        "ssh-rsa AAAA",
        "ssh-dss AAAA comment",
        "ssh-ed25519",
        "ssh-ecdsa-!bad AAAA",
      ],
    });
    const invalidReserved = sanitizeMihomoProxyNode({
      name: "WG",
      type: "wireguard",
      server: "wg.example.com",
      port: 51820,
      "private-key": WIREGUARD_KEY,
      reserved: "1,2",
    });
    const explicitEmptyDownloadReality = normalizeMihomoVlessForGeneration({
      name: "XHTTP",
      type: "vless",
      uuid: "11111111-1111-4111-8111-111111111111",
      network: "xhttp",
      "reality-opts": {
        "public-key": REALITY_PUBLIC_KEY,
      },
      "xhttp-opts": {
        "download-settings": {
          "reality-opts": {
            "public-key": "",
          },
        },
      },
    });
    const invalidDownloadReality = normalizeMihomoVlessForGeneration({
      name: "XHTTP",
      type: "vless",
      uuid: "11111111-1111-4111-8111-111111111111",
      network: "xhttp",
      "reality-opts": {
        "public-key": REALITY_PUBLIC_KEY,
      },
      "xhttp-opts": {
        "download-settings": {
          "reality-opts": {
            "public-key": "bad",
          },
        },
      },
    });
    const invalidMainReality = normalizeMihomoVlessForGeneration({
      name: "Reality",
      type: "vless",
      uuid: "11111111-1111-4111-8111-111111111111",
      "reality-opts": "bad",
    });
    const prefixedCertificate = sanitizeMihomoProxyNode({
      name: "HTTPS",
      type: "https",
      server: "https.example.com",
      port: 443,
      fingerprint: "SHA256=" + "C".repeat(64).match(/.{1,2}/g)?.join(":"),
    });

    expect(isMihomoSupportedProxyNode({ type: "ss", cipher: "", password: "secret" })).toBe(false);
    expect(
      isMihomoSupportedProxyNode({
        type: "vless",
        uuid: "11111111-1111-4111-8111-111111111111",
        network: "xhttp",
        "reality-opts": {
          "public-key": REALITY_PUBLIC_KEY,
        },
        "xhttp-opts": {
          "download-settings": {
            "reality-opts": {
              "public-key": "bad",
            },
          },
        },
      })
    ).toBe(false);
    expect(ssh).toMatchObject({ "host-key": ["ssh-rsa AAAA", "ssh-dss AAAA comment"] });
    expect(invalidReserved).not.toHaveProperty("reserved");
    expect(explicitEmptyDownloadReality).toMatchObject({
      "xhttp-opts": {
        "download-settings": {
          "reality-opts": {
            "public-key": "",
          },
        },
      },
    });
    expect(invalidDownloadReality).toHaveProperty("_subboost-invalid-mihomo-node", true);
    expect(invalidMainReality).toHaveProperty("_subboost-invalid-mihomo-node", true);
    expect(prefixedCertificate).toHaveProperty("fingerprint", "c".repeat(64));
  });

  it("covers conservative sanitizer fallbacks for omitted and malformed optional fields", () => {
    const sshWithScalarHostKey = sanitizeMihomoProxyNode({
      name: "SSH",
      type: "ssh",
      server: "ssh.example.com",
      port: 22,
      password: "secret",
      "host-key": "ssh-rsa AAAA",
      "private-key": undefined,
      "server-fingerprint": 1,
    });
    const sshWithEmptyHostKeyMaterial = sanitizeMihomoProxyNode({
      name: "SSH",
      type: "ssh",
      server: "ssh.example.com",
      port: 22,
      password: "secret",
      "host-key": ["ssh-rsa ", "ssh-ecdsa- AAAA", "ssh-ed25519 AAAA"],
    });
    const wireguardWithUndefinedOptionalKeys = sanitizeMihomoProxyNode({
      name: "WG",
      type: "wireguard",
      server: "wg.example.com",
      port: 51820,
      "private-key": WIREGUARD_KEY,
      "public-key": undefined,
      "pre-shared-key": undefined,
      reserved: "",
    });
    const plainHttp = sanitizeMihomoProxyNode({
      name: "HTTP",
      type: "http",
      server: "http.example.com",
      port: 80,
      udp: "TRUE",
      tls: "FALSE",
      alpn: [],
      fingerprint: "Not-A-Known-Alias",
      "ws-opts": {},
    });
    const vlessWithoutReality = sanitizeMihomoProxyNode({
      name: "VLESS",
      type: "vless",
      server: "vless.example.com",
      port: 443,
      uuid: "11111111-1111-4111-8111-111111111111",
      network: "xhttp",
      "xhttp-opts": {
        "download-settings": {
          "reality-opts": {
            "public-key": REALITY_PUBLIC_KEY,
            "short-id": "not-hex",
          },
          "ech-opts": {
            enable: "0",
            config: "",
            "query-server-name": " ",
          },
        },
      },
    });

    expect(sshWithScalarHostKey).not.toHaveProperty("host-key");
    expect(sshWithScalarHostKey).not.toHaveProperty("private-key");
    expect(sshWithScalarHostKey).not.toHaveProperty("server-fingerprint");
    expect(sshWithEmptyHostKeyMaterial).toHaveProperty("host-key", ["ssh-ed25519 AAAA"]);
    expect(wireguardWithUndefinedOptionalKeys).toMatchObject({
      "private-key": WIREGUARD_KEY,
    });
    expect(wireguardWithUndefinedOptionalKeys).not.toHaveProperty("public-key");
    expect(wireguardWithUndefinedOptionalKeys).not.toHaveProperty("pre-shared-key");
    expect(wireguardWithUndefinedOptionalKeys).not.toHaveProperty("reserved");
    expect(plainHttp).toMatchObject({ udp: true, tls: false });
    expect(plainHttp).not.toHaveProperty("alpn");
    expect(plainHttp).not.toHaveProperty("fingerprint");
    expect(plainHttp).not.toHaveProperty("ws-opts");
    expect(vlessWithoutReality).toMatchObject({
      "xhttp-opts": {
        "download-settings": {
          "reality-opts": {
            "public-key": REALITY_PUBLIC_KEY,
          },
          "ech-opts": {
            enable: false,
          },
        },
      },
    });
    expect(
      (vlessWithoutReality["xhttp-opts"] as Record<string, Record<string, unknown>>)["download-settings"][
        "reality-opts"
      ]
    ).not.toHaveProperty("short-id");
    expect(
      (vlessWithoutReality["xhttp-opts"] as Record<string, Record<string, unknown>>)["download-settings"]["ech-opts"]
    ).not.toHaveProperty("config");
    expect(
      (vlessWithoutReality["xhttp-opts"] as Record<string, Record<string, unknown>>)["download-settings"]["ech-opts"]
    ).not.toHaveProperty("query-server-name");

    // Nodes without a usable endpoint are dropped since upstream 6286f8f.
    expect(isMihomoSupportedProxyNode({ type: "http", name: "HTTP" })).toBe(false);
    expect(isMihomoSupportedProxyNode({ type: "http", name: "HTTP", server: "http.example.com", port: 80 })).toBe(true);
    expect(
      isMihomoSupportedProxyNode({
        type: "wireguard",
        name: "WG",
        server: "wg.example.com",
        port: 51820,
        "private-key": WIREGUARD_KEY,
        "public-key": undefined,
        "pre-shared-key": WIREGUARD_KEY,
      })
    ).toBe(true);
    expect(
      isMihomoSupportedProxyNode({
        type: "ssh",
        name: "SSH",
        server: "ssh.example.com",
        port: 22,
        "private-key": "bad",
      })
    ).toBe(false);
    expect(
      isMihomoSupportedProxyNode({
        type: "ssh",
        name: "SSH",
        server: "ssh.example.com",
        port: 22,
        "private-key": PRIVATE_KEY,
      })
    ).toBe(true);
    expect(
      isMihomoSupportedProxyNode({
        type: "ss",
        name: "SS",
        server: "ss.example.com",
        port: 8388,
        cipher: "aes-128-gcm",
        password: "secret",
        plugin: "simple-obfs",
      })
    ).toBe(true);
  });

  it("covers remaining protocol support and cleanup fallbacks", () => {
    expect(isStandardBase64String("abcd!")).toBe(false);
    expect(
      isMihomoSupportedProxyNode({
        type: "ssr",
        name: "SSR",
        server: "ssr.example.com",
        port: 8388,
        cipher: "aes-128-gcm",
        password: "secret",
        protocol: "",
        obfs: "plain",
      })
    ).toBe(false);
    expect(
      isMihomoSupportedProxyNode({
        type: "vless",
        name: "XHTTP",
        server: "vless.example.com",
        port: 443,
        uuid: "11111111-1111-4111-8111-111111111111",
        network: "xhttp",
        "reality-opts": { "public-key": REALITY_PUBLIC_KEY },
        "xhttp-opts": {
          mode: "stream-one",
          "download-settings": {
            path: "/download",
          },
        },
      })
    ).toBe(false);
    expect(
      isMihomoSupportedProxyNode({
        type: "vless",
        name: "XHTTP",
        server: "vless.example.com",
        port: 443,
        uuid: "11111111-1111-4111-8111-111111111111",
        network: "xhttp",
        "reality-opts": { "public-key": REALITY_PUBLIC_KEY },
        "xhttp-opts": {
          "download-settings": {
            "reality-opts": {
              "public-key": "",
            },
          },
        },
      })
    ).toBe(true);

    const invalidContainers = sanitizeMihomoProxyNode({
      name: "Containers",
      type: "vmess",
      server: "vmess.example.com",
      port: 443,
      uuid: "11111111-1111-4111-8111-111111111111",
      ech: "bad",
      alpn: 443,
      "ech-opts": [],
      "ws-opts": {},
      fingerprint: "unknown",
    });
    const sshWithoutHostKey = sanitizeMihomoProxyNode({
      name: "SSH",
      type: "ssh",
      server: "ssh.example.com",
      port: 22,
      password: "secret",
      "host-key": "ssh-ed25519 AAAA",
      "server-fingerprint": `SHA256:${"B".repeat(43)}=`,
    });
    const wireguardMissingReserved = sanitizeMihomoProxyNode({
      name: "WG",
      type: "wireguard",
      server: "wg.example.com",
      port: 51820,
      "private-key": WIREGUARD_KEY,
      reserved: "1,2",
    });
    const noRealityDownloadSettings = normalizeMihomoVlessForGeneration({
      name: "XHTTP",
      type: "vless",
      uuid: "11111111-1111-4111-8111-111111111111",
      network: "xhttp",
      "xhttp-opts": {
        "download-settings": {
          path: "/download",
        },
      },
    });
    const invalidDownloadReality = normalizeMihomoVlessForGeneration({
      name: "XHTTP",
      type: "vless",
      uuid: "11111111-1111-4111-8111-111111111111",
      network: "xhttp",
      "xhttp-opts": {
        "download-settings": {
          "reality-opts": {
            "public-key": "bad",
          },
        },
      },
    });
    const explicitTlsReality = normalizeMihomoVlessForGeneration({
      name: "Reality",
      type: "vless",
      uuid: "11111111-1111-4111-8111-111111111111",
      tls: true,
      "client-fingerprint": "edge",
      "reality-opts": {
        "public-key": REALITY_PUBLIC_KEY,
      },
    });
    const noEncryption = sanitizeMihomoProxyNode({
      name: "VLESS",
      type: "vless",
      server: "vless.example.com",
      port: 443,
      uuid: "11111111-1111-4111-8111-111111111111",
      encryption: " ",
    });

    expect(invalidContainers).not.toHaveProperty("alpn");
    expect(invalidContainers).not.toHaveProperty("ech-opts");
    expect(invalidContainers).not.toHaveProperty("fingerprint");
    expect(invalidContainers).not.toHaveProperty("ws-opts");
    expect(sshWithoutHostKey).not.toHaveProperty("host-key");
    expect(sshWithoutHostKey).toHaveProperty("server-fingerprint", `SHA256:${"B".repeat(43)}=`);
    expect(wireguardMissingReserved).not.toHaveProperty("reserved");
    expect(noRealityDownloadSettings).toMatchObject({
      "xhttp-opts": {
        "download-settings": {
          path: "/download",
        },
      },
    });
    expect(invalidDownloadReality).toHaveProperty("_subboost-invalid-mihomo-node", true);
    expect(explicitTlsReality).toMatchObject({
      tls: true,
      "client-fingerprint": "edge",
    });
    expect(noEncryption).not.toHaveProperty("encryption");
  });
});
