import { describe, expect, it } from "vitest";
import type { ParsedNode } from "../types/node";
import { ORIGIN_NAME_KEY, SOURCE_IDS_KEY } from "./node-source-state";
import { mergeParsedSourceNodes, prepareSourceParsedNodes } from "./source-node-refresh";

const REALITY_UUID = "11111111-1111-1111-1111-111111111111";

function realityNode(name: string, spiderX: string, patch: Record<string, unknown> = {}): ParsedNode {
  return {
    name,
    type: "vless",
    server: "reality.example.com",
    port: 443,
    uuid: REALITY_UUID,
    tls: true,
    "client-fingerprint": "chrome",
    flow: "xtls-rprx-vision",
    network: "tcp",
    udp: true,
    "reality-opts": {
      "public-key": "FAKE_PUBLIC_KEY_AAAAAAAAAAAAAAAA",
      "short-id": "0000",
      "_spider-x": spiderX,
    },
    ...patch,
  } as ParsedNode;
}

function ssNode(name: string): ParsedNode {
  return {
    name,
    type: "ss",
    server: `${name.toLowerCase()}.example.com`,
    port: 8388,
    cipher: "aes-128-gcm",
    password: "secret",
  } as ParsedNode;
}

describe("source node refresh reality identity", () => {
  it("keeps matching a reality node when spider-x rotates and updates its automatic name", () => {
    const state = [
      ssNode("before"),
      realityNode("Reality Node A (v1)", "/spider-old", {
        [ORIGIN_NAME_KEY]: "Reality Node A (v1)",
        [SOURCE_IDS_KEY]: ["source-a"],
      }),
      ssNode("after"),
    ];
    const parsed = prepareSourceParsedNodes([realityNode("Reality Node A (v2)", "/spider-new")], {});

    const result = mergeParsedSourceNodes(state, parsed, [], { sourceId: "source-a" });

    expect(result.nodes.map((node) => node.name)).toEqual(["before", "Reality Node A (v2)", "after"]);
    expect(result.nodes[1]).toMatchObject({
      uuid: REALITY_UUID,
      [ORIGIN_NAME_KEY]: "Reality Node A (v2)",
      [SOURCE_IDS_KEY]: ["source-a"],
    });
    expect(
      (result.nodes[1] as unknown as { "reality-opts"?: { "_spider-x"?: string } })["reality-opts"]?.["_spider-x"]
    ).toBe("/spider-new");
  });

  it("preserves a manual name while refreshing the origin and spider-x", () => {
    const state = [
      realityNode("Pinned Reality Name", "/spider-old", {
        [ORIGIN_NAME_KEY]: "Reality Node A (v1)",
        [SOURCE_IDS_KEY]: ["source-a"],
      }),
    ];
    const parsed = prepareSourceParsedNodes([realityNode("Reality Node A (v2)", "/spider-new")], {});

    const result = mergeParsedSourceNodes(state, parsed, [], { sourceId: "source-a" });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      name: "Pinned Reality Name",
      uuid: REALITY_UUID,
      [ORIGIN_NAME_KEY]: "Reality Node A (v2)",
      [SOURCE_IDS_KEY]: ["source-a"],
    });
    expect(
      (result.nodes[0] as unknown as { "reality-opts"?: { "_spider-x"?: string } })["reality-opts"]?.["_spider-x"]
    ).toBe("/spider-new");
  });
});
