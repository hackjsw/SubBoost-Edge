import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { parseSubscription } from "../parser";
import { generateClashYaml } from "../generator";
import { sanitizeMihomoProxyNode } from "./proxy-sanitizer";

const publicKey = "A".repeat(43);

describe("upstream protocol field preservation", () => {
  it.each([true, false, "true", "false", 1, 0])("normalizes explicit Reality support %s through YAML generation", (support) => {
    const input = { name: "Reality", type: "vless", server: "local.subboost.test", port: 443,
      uuid: "11111111-1111-4111-8111-111111111111", "reality-opts": {
        "public-key": publicKey, "support-x25519mlkem768": support,
      } };
    const parsed = parseSubscription(yaml.dump({ proxies: [input] }));
    expect(parsed.errors).toEqual([]);
    const generated = yaml.load(generateClashYaml({ nodes: parsed.nodes })) as { proxies: Array<Record<string, unknown>> };
    expect(generated.proxies[0]["reality-opts"]).toMatchObject({
      "support-x25519mlkem768": [true, "true", 1].includes(support),
    });
  });

  it("keeps Reality defaults and removes malformed support flags", () => {
    const input = { type: "vless", "reality-opts": { "public-key": publicKey } };
    expect(sanitizeMihomoProxyNode(input)["reality-opts"]).toEqual(input["reality-opts"]);
    expect(sanitizeMihomoProxyNode({ ...input, "reality-opts": {
      ...input["reality-opts"], "support-x25519mlkem768": "invalid",
    } })["reality-opts"]).toEqual(input["reality-opts"]);
  });

  it.each(["ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"])("retains the configured SSH %s host key", (kind) => {
    const hostKey = `${kind} AAAA`;
    const node = sanitizeMihomoProxyNode({ type: "ssh", "host-key": [hostKey] });
    expect(node["host-key"]).toEqual([hostKey]);
  });

  it("preserves WireGuard Base64 reserved bytes", () => {
    expect(sanitizeMihomoProxyNode({ type: "wireguard", reserved: "U4An" }).reserved).toEqual([83, 128, 39]);
    expect(sanitizeMihomoProxyNode({ type: "wireguard", reserved: "AAAA" }).reserved).toEqual([0, 0, 0]);
    expect(sanitizeMihomoProxyNode({ type: "wireguard", reserved: "1,2,3" }).reserved).toEqual([1, 2, 3]);
    expect(sanitizeMihomoProxyNode({ type: "wireguard", reserved: "U4AnAA==" })).not.toHaveProperty("reserved");
  });
});
