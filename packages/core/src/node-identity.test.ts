import { describe, expect, it } from "vitest";
import type { ParsedNode } from "./types/node";
import { buildNodeContentKey, stableJsonStringify } from "./node-identity";

// 测试数据全部为虚构，不包含任何真实订阅信息
function realityNode(name: string, uuid: string, spiderX: string, patch: Record<string, unknown> = {}): ParsedNode {
  return {
    name,
    type: "vless",
    server: "reality.example.com",
    port: 443,
    uuid,
    tls: true,
    "client-fingerprint": "chrome",
    flow: "xtls-rprx-vision",
    network: "tcp",
    "reality-opts": {
      "public-key": "FAKE_PUBLIC_KEY_AAAAAAAAAAAAAAAA",
      "short-id": "0000",
      "_spider-x": spiderX,
    },
    ...patch,
  } as unknown as ParsedNode;
}

const UUID_A = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";

describe("stableJsonStringify", () => {
  it("preserves nested underscore-prefixed keys for generic serialization", () => {
    const first = stableJsonStringify({ nested: { _nonce: "a", value: 1 } });
    const second = stableJsonStringify({ nested: { _nonce: "b", value: 1 } });

    expect(first).toBe('{"nested":{"_nonce":"a","value":1}}');
    expect(second).not.toBe(first);
  });
});

describe("buildNodeContentKey", () => {
  it("ignores nested internal underscore fields such as reality-opts._spider-x", () => {
    const stored = realityNode("Reality Node A (v1)", UUID_A, "/spider-old");
    const fresh = realityNode("Reality Node A (v2)", UUID_A, "/spider-new");

    // spider-x 轮换 + 显示名动态变化，不应改变内容指纹
    expect(buildNodeContentKey(fresh)).toBe(buildNodeContentKey(stored));
  });

  it("still distinguishes nodes whose real identity fields differ", () => {
    const nodeA = realityNode("Node A", UUID_A, "/spider-a");
    const nodeB = realityNode("Node B", UUID_B, "/spider-a");

    expect(buildNodeContentKey(nodeB)).not.toBe(buildNodeContentKey(nodeA));
  });

  it("keeps ignoring top-level internal fields (existing behavior)", () => {
    const base = realityNode("Same Node", UUID_A, "/spider");
    const withMeta = {
      ...base,
      _sourceIds: ["source-a"],
      _originName: "origin-a",
      _meta: { importedAt: 1 },
    };

    expect(buildNodeContentKey(withMeta)).toBe(buildNodeContentKey(base));
  });
});
