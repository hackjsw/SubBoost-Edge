import { describe, expect, it } from "vitest";
import type { ParsedNode } from "../types/node";
import {
  detachSourceNodesFromState,
  mergeParsedSourceNodes,
  prepareSourceParsedNodes,
} from "./source-node-refresh";
import { ORIGIN_NAME_KEY, SOURCE_IDS_KEY } from "./node-source-state";
import {
  mergeSubscriptionResponseInfo,
  normalizeSubscriptionResponseInfo,
  pickSubscriptionResponseInfoFromHeaders,
  resolveClientProfileUpdateIntervalSeconds,
} from "./subscription-response-info";
import {
  autoUpdateIntervalHoursToSeconds,
  autoUpdateIntervalSecondsToHours,
  getAutoUpdateIntervalPolicyMinLabel,
  getMinAutoUpdateIntervalHours,
  getMinAutoUpdateIntervalLabel,
  getMinAutoUpdateIntervalSeconds,
  resolveAutoUpdateIntervalPolicy,
} from "./auto-update-interval";

function ssNode(name: string, patch: Record<string, unknown> = {}): ParsedNode {
  return {
    name,
    type: "ss",
    server: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "node"}.example.com`,
    port: 8388,
    cipher: "aes-128-gcm",
    password: "secret",
    ...patch,
  } as ParsedNode;
}

describe("source node refresh helpers", () => {
  it("prepares parsed nodes with display names, origins, and sanitized imported-only fields", () => {
    const [prepared] = prepareSourceParsedNodes(
      [ssNode(" Alpha ", { "dialer-proxy": "private-only", dialer_proxy: "private-only" })],
      { currentTag: " Airport ", currentNameTemplate: "{name} [{tag}]" }
    );

    expect(prepared).toMatchObject({
      name: "Alpha [Airport]",
      [ORIGIN_NAME_KEY]: "Alpha",
    });
    expect(prepared).not.toHaveProperty("dialer-proxy");
    expect(prepared).not.toHaveProperty("dialer_proxy");

    const [plain] = prepareSourceParsedNodes([ssNode("Plain")], {
      currentTag: " ",
      currentNameTemplate: " ",
    });
    expect(plain).toMatchObject({
      name: "Plain",
      [ORIGIN_NAME_KEY]: "Plain",
    });

    const [blank] = prepareSourceParsedNodes([ssNode("   ")], {});
    expect(blank).toMatchObject({
      name: "",
      [ORIGIN_NAME_KEY]: "",
    });
  });

  it("detaches a source id while preserving nodes still owned by other sources", () => {
    const result = detachSourceNodesFromState(
      [
        ssNode("Shared", { [SOURCE_IDS_KEY]: ["source-a", "source-b"] }),
        ssNode("Only A", { [SOURCE_IDS_KEY]: ["source-a"] }),
        ssNode("Manual"),
      ],
      "source-a"
    );

    expect(result.renameMap.size).toBe(0);
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]).toMatchObject({
      name: "Shared",
      [SOURCE_IDS_KEY]: ["source-b"],
      [ORIGIN_NAME_KEY]: "Shared",
    });
    expect(result.nodes[1]).toMatchObject({
      name: "Manual",
      [ORIGIN_NAME_KEY]: "Manual",
    });
  });

  it("merges refreshed source nodes while preserving manual renames and deleted nodes", () => {
    const stateNodes = [
      ssNode("[Old]Alpha", {
        server: "old-alpha.example.com",
        [ORIGIN_NAME_KEY]: "Alpha",
        [SOURCE_IDS_KEY]: ["source-a"],
      }),
      ssNode("Custom Beta", {
        server: "old-beta.example.com",
        [ORIGIN_NAME_KEY]: "Beta",
        [SOURCE_IDS_KEY]: ["source-a"],
        _pinned: true,
      }),
      ssNode("Shared", {
        [ORIGIN_NAME_KEY]: "Shared",
        [SOURCE_IDS_KEY]: ["source-b", "source-a"],
      }),
      ssNode("Manual"),
    ];
    const parsedNodes = prepareSourceParsedNodes(
      [
        ssNode("Alpha", { server: "new-alpha.example.com" }),
        ssNode("Beta", { server: "new-beta.example.com" }),
        ssNode("Gamma", { server: "new-gamma.example.com" }),
        ssNode("Deleted", { server: "deleted.example.com" }),
      ],
      { currentTag: "New", currentNameTemplate: "[{tag}]{name}" }
    );

    const result = mergeParsedSourceNodes(stateNodes, parsedNodes, ["[Old]Deleted"], {
      sourceId: "source-a",
      lastTag: "Old",
      lastNameTemplate: "[{tag}]{name}",
      currentTag: "New",
      currentNameTemplate: "[{tag}]{name}",
    });

    expect(result.nodes.map((node) => node.name)).toEqual([
      "[New]Alpha",
      "Custom Beta",
      "[New]Gamma",
      "Shared",
      "Manual",
    ]);
    expect(result.nodes[0]).toMatchObject({
      server: "new-alpha.example.com",
      [ORIGIN_NAME_KEY]: "Alpha",
      [SOURCE_IDS_KEY]: ["source-a"],
    });
    expect(result.nodes[1]).toMatchObject({
      name: "Custom Beta",
      server: "new-beta.example.com",
      _pinned: true,
      [ORIGIN_NAME_KEY]: "Beta",
      [SOURCE_IDS_KEY]: ["source-a"],
    });
    expect(result.nodes[2]).toMatchObject({
      server: "new-gamma.example.com",
      [ORIGIN_NAME_KEY]: "Gamma",
      [SOURCE_IDS_KEY]: ["source-a"],
    });
    expect(result.nodes[3]).toMatchObject({
      name: "Shared",
      [SOURCE_IDS_KEY]: ["source-b"],
    });
    expect(Array.from(result.renameMap.entries())).toEqual([["[Old]Alpha", "[New]Alpha"]]);
  });

  it("preserves Reality ML-KEM support when a refreshed source omits the optional flag", () => {
    const publicKey = "A".repeat(43);
    const stored = {
      name: "LAX",
      type: "vless",
      server: "lax.example.com",
      port: 443,
      uuid: "11111111-1111-4111-8111-111111111111",
      tls: true,
      "reality-opts": {
        "public-key": publicKey,
        "short-id": "85ca60a2130fe837",
        "support-x25519mlkem768": true,
      },
      [ORIGIN_NAME_KEY]: "LAX",
      [SOURCE_IDS_KEY]: ["source-a"],
    } as ParsedNode;
    const fresh = prepareSourceParsedNodes(
      [
        {
          ...stored,
          "reality-opts": {
            "public-key": publicKey,
            "short-id": "85ca60a2130fe837",
          },
        } as ParsedNode,
      ],
      {}
    );

    const result = mergeParsedSourceNodes([stored], fresh, [], { sourceId: "source-a" });

    expect(result.nodes[0]["reality-opts"]).toMatchObject({
      "public-key": publicKey,
      "short-id": "85ca60a2130fe837",
      "support-x25519mlkem768": true,
    });
    expect(result.nodes[0][SOURCE_IDS_KEY]).toEqual(["source-a"]);
  });

  it("can refresh as a new source without treating old display names as manual renames", () => {
    const parsedNodes = prepareSourceParsedNodes([ssNode("Alpha")], {
      currentTag: "New",
      currentNameTemplate: "[{tag}]{name}",
    });
    const result = mergeParsedSourceNodes(
      [
        ssNode("Custom Alpha", {
          [ORIGIN_NAME_KEY]: "Alpha",
          [SOURCE_IDS_KEY]: ["source-a"],
        }),
      ],
      parsedNodes,
      [],
      {
        sourceId: "source-a",
        currentTag: "New",
        currentNameTemplate: "[{tag}]{name}",
        treatAsNewSource: true,
      }
    );

    expect(result.nodes[0]).toMatchObject({
      name: "[New]Alpha",
      [ORIGIN_NAME_KEY]: "Alpha",
      [SOURCE_IDS_KEY]: ["source-a"],
    });
    expect(Array.from(result.renameMap.entries())).toEqual([["Custom Alpha", "[New]Alpha"]]);
  });

  it("matches manual display names only when smart matching is allowed", () => {
    const parsedNodes = prepareSourceParsedNodes([ssNode("Manual Match", { server: "fresh.example.com" })], {});
    const state = [ssNode("Manual Match", { [ORIGIN_NAME_KEY]: "Old Manual" })];
    const smart = mergeParsedSourceNodes(state, parsedNodes, [], {
      sourceId: "source-a",
    });
    const strict = mergeParsedSourceNodes(state, parsedNodes, [], {
      sourceId: "source-a",
      smartNodeMatchingEnabled: false,
    });

    expect(smart.nodes).toHaveLength(1);
    expect(smart.nodes[0]).toMatchObject({
      name: "Manual Match",
      server: "fresh.example.com",
      [SOURCE_IDS_KEY]: ["source-a"],
    });
    expect(strict.nodes).toHaveLength(2);
    expect(strict.nodes.map((node) => node.name)).toEqual(["Manual Match", "Manual Match (2)"]);
  });

  it("does not infer a match when fresh content keys are ambiguous", () => {
    const state = [
      ssNode("Existing", {
        server: "same.example.com",
      }),
    ];
    const parsed = prepareSourceParsedNodes(
      [
        ssNode("Fresh A", { server: "same.example.com" }),
        ssNode("Fresh B", { server: "same.example.com" }),
      ],
      {}
    );

    const result = mergeParsedSourceNodes(state, parsed, [], {
      sourceId: "source-a",
    });

    expect(result.nodes.map((node) => node.name)).toEqual(["Existing", "Fresh A", "Fresh B"]);
    expect(result.nodes[0]).not.toHaveProperty(SOURCE_IDS_KEY);
  });

  it("keeps source insertion position and renames colliding refreshed nodes", () => {
    const state = [
      ssNode("Before"),
      ssNode("One", {
        [ORIGIN_NAME_KEY]: "One",
        [SOURCE_IDS_KEY]: ["source-a"],
      }),
      ssNode("After", { type: "trojan", password: "secret", [ORIGIN_NAME_KEY]: "Other" }),
    ];
    const parsed = prepareSourceParsedNodes([ssNode("One"), ssNode("After")], {});

    const result = mergeParsedSourceNodes(state, parsed, [], {
      sourceId: "source-a",
      lastNameTemplate: "{name}",
      currentNameTemplate: "{name}",
    });

    expect(result.nodes.map((node) => node.name)).toEqual(["Before", "One", "After (2)", "After"]);
    expect(Array.from(result.renameMap.entries())).toEqual([]);
  });

  it("drops vanished source-only nodes and skips deleted or duplicate fresh nodes", () => {
    const state = [
      ssNode("Gone", {
        [ORIGIN_NAME_KEY]: "Gone",
        [SOURCE_IDS_KEY]: ["source-a"],
      }),
      ssNode("Shared Gone", {
        [ORIGIN_NAME_KEY]: "Shared Gone",
        [SOURCE_IDS_KEY]: ["source-a", "source-b"],
      }),
      ssNode("Manual"),
    ];
    const parsed = prepareSourceParsedNodes(
      [
        ssNode("Fresh"),
        ssNode("Fresh"),
        ssNode("Deleted"),
      ],
      {}
    );

    const result = mergeParsedSourceNodes(state, parsed, [" Deleted "], {
      sourceId: "source-a",
      lastNameTemplate: "{name}",
      currentNameTemplate: "{name}",
      smartNodeMatchingEnabled: false,
    });

    expect(result.nodes.map((node) => node.name)).toEqual(["Shared Gone", "Manual", "Fresh"]);
    expect(result.nodes[0]).toMatchObject({
      [SOURCE_IDS_KEY]: ["source-b"],
    });
  });

  it("does not let one legacy deleted origin hide an entire duplicate-origin batch", () => {
    const parsed = prepareSourceParsedNodes(
      [
        ssNode("SOCKS-same.example.com:1080", { server: "same.example.com", port: 1080, password: "one" }),
        ssNode("SOCKS-same.example.com:1080", { server: "same.example.com", port: 1080, password: "two" }),
      ],
      {}
    );

    const result = mergeParsedSourceNodes([], parsed, ["SOCKS-same.example.com:1080"], {
      sourceId: "source-a",
    });

    expect(result.nodes.map((node) => node.name)).toEqual([
      "SOCKS-same.example.com:1080",
      "SOCKS-same.example.com:1080 (2)",
    ]);
    expect(result.nodes).toEqual([
      expect.objectContaining({ [SOURCE_IDS_KEY]: ["source-a"], password: "one" }),
      expect.objectContaining({ [SOURCE_IDS_KEY]: ["source-a"], password: "two" }),
    ]);
  });

  it("still skips exact deleted nodes inside a duplicate-origin batch", () => {
    const deletedNode = ssNode("SOCKS-same.example.com:1080", {
      server: "same.example.com",
      port: 1080,
      password: "one",
      [ORIGIN_NAME_KEY]: "SOCKS-same.example.com:1080",
    });
    const parsed = prepareSourceParsedNodes(
      [
        ssNode("SOCKS-same.example.com:1080", { server: "same.example.com", port: 1080, password: "one" }),
        ssNode("SOCKS-same.example.com:1080", { server: "same.example.com", port: 1080, password: "two" }),
      ],
      {}
    );

    const result = mergeParsedSourceNodes([], parsed, ["SOCKS-same.example.com:1080"], {
      sourceId: "source-a",
      deletedNodes: [
        {
          originName: "SOCKS-same.example.com:1080",
          name: "SOCKS-same.example.com:1080",
          node: deletedNode,
        },
      ],
    });

    expect(result.nodes).toEqual([
      expect.objectContaining({
        name: "SOCKS-same.example.com:1080",
        [SOURCE_IDS_KEY]: ["source-a"],
        password: "two",
      }),
    ]);
  });

  it("smart-matches existing manual nodes by content and preserves source id order", () => {
    const state = [
      ssNode("Manual Existing", {
        server: "same.example.com",
        [SOURCE_IDS_KEY]: ["source-b", "source-a", "source-b", ""],
      }),
      ssNode("Content Match", {
        server: "content.example.com",
      }),
    ];
    const parsed = prepareSourceParsedNodes(
      [
        ssNode("Manual Existing", { server: "same-new.example.com" }),
        ssNode("Fresh Content", { server: "content.example.com" }),
      ],
      {}
    );

    const result = mergeParsedSourceNodes(state, parsed, [], {
      sourceId: "source-a",
      lastNameTemplate: "{name}",
      currentNameTemplate: "{name}",
    });

    expect(result.nodes.map((node) => node.name)).toEqual(["Manual Existing", "Content Match"]);
    expect(result.nodes[0]).toMatchObject({
      server: "same-new.example.com",
      [SOURCE_IDS_KEY]: ["source-b", "source-a"],
    });
    expect(result.nodes[1]).toMatchObject({
      server: "content.example.com",
      [ORIGIN_NAME_KEY]: "Fresh Content",
      [SOURCE_IDS_KEY]: ["source-a"],
    });
  });

  it("honors display-name deleted markers and exact deleted-node descriptors", () => {
    const deleted = ssNode("Deleted Origin", {
      server: "deleted.example.com",
      [ORIGIN_NAME_KEY]: "Deleted Origin",
    });
    const parsed = prepareSourceParsedNodes(
      [
        ssNode("Origin A", { server: "a.example.com" }),
        deleted,
        ssNode("Origin C", { server: "c.example.com" }),
      ],
      { currentTag: "New", currentNameTemplate: "{tag}-{name}" }
    );

    const result = mergeParsedSourceNodes([], parsed, ["New-Origin A"], {
      sourceId: "source-a",
      deletedNodes: [
        { node: undefined },
        { originName: "Deleted Origin", node: deleted },
      ],
    });

    expect(result.nodes.map((node) => node.name)).toEqual(["New-Origin C"]);
  });

  it("uses deleted-node fallback origin metadata and ignores blank fresh origins", () => {
    const deletedByNodeOrigin = ssNode("Deleted By Node", {
      server: "deleted-by-node.example.com",
      [ORIGIN_NAME_KEY]: "Deleted By Node",
    });
    const parsed = prepareSourceParsedNodes(
      [
        deletedByNodeOrigin,
        ssNode("   ", { server: "blank-origin.example.com" }),
        ssNode("Kept", { server: "kept.example.com" }),
      ],
      {}
    );

    const result = mergeParsedSourceNodes([], parsed, [], {
      sourceId: "source-a",
      deletedNodes: [
        { originName: 1, node: deletedByNodeOrigin },
        { name: "ignored", node: ssNode("   ") },
      ],
    });

    expect(result.nodes.map((node) => node.name)).toEqual(["Kept"]);
  });

  it("avoids display-name fallback across different node types and records fixed-name collisions", () => {
    const parsed = prepareSourceParsedNodes([ssNode("Shared Name", { server: "fresh-shared.example.com" })], {});
    const noSameType = mergeParsedSourceNodes(
      [
        ssNode("Shared Name", {
          type: "trojan",
          password: "secret",
          server: "manual-trojan.example.com",
          [ORIGIN_NAME_KEY]: "Other Origin",
        }),
      ],
      parsed,
      [],
      { sourceId: "source-a" }
    );

    expect(noSameType.nodes.map((node) => node.name)).toEqual(["Shared Name", "Shared Name (2)"]);

    const renamed = mergeParsedSourceNodes(
      [
        ssNode("Keep", { [ORIGIN_NAME_KEY]: "Keep", [SOURCE_IDS_KEY]: ["source-a"] }),
        ssNode("Keep", { [ORIGIN_NAME_KEY]: "Other", [SOURCE_IDS_KEY]: ["source-b"] }),
      ],
      prepareSourceParsedNodes([ssNode("Keep")], {}),
      [],
      { sourceId: "source-a", lastNameTemplate: "{name}", currentNameTemplate: "{name}" }
    );

    expect(renamed.nodes.map((node) => node.name)).toEqual(["Keep (2)", "Keep"]);
    expect(Array.from(renamed.renameMap.entries())).toEqual([["Keep", "Keep (2)"]]);
  });

  it("consumes one matching fresh node and merges unowned base nodes by content", () => {
    const state = [
      ssNode("Manual One", {
        server: "same-origin.example.com",
        [ORIGIN_NAME_KEY]: "Shared Origin",
      }),
      ssNode("Manual Two", {
        server: "same-origin.example.com",
        [ORIGIN_NAME_KEY]: "Shared Origin",
      }),
      ssNode("Other Source", {
        server: "content-match.example.com",
        [ORIGIN_NAME_KEY]: "Fresh Content",
        [SOURCE_IDS_KEY]: ["source-b"],
      }),
    ];
    const parsed = prepareSourceParsedNodes(
      [
        ssNode("Shared Origin", { server: "same-origin.example.com" }),
        ssNode("Fresh Content", { server: "content-match.example.com" }),
      ],
      {}
    );

    const result = mergeParsedSourceNodes(state, parsed, [], {
      sourceId: "source-a",
    });

    expect(result.nodes.map((node) => node.name)).toEqual(["Manual One", "Other Source"]);
    expect(result.nodes[0]).toMatchObject({
      [SOURCE_IDS_KEY]: ["source-a"],
    });
    expect(result.nodes[1]).toMatchObject({
      [ORIGIN_NAME_KEY]: "Fresh Content",
      [SOURCE_IDS_KEY]: ["source-b", "source-a"],
    });
  });

  it("matches display names while cleaning source ids from refreshed records", () => {
    const parsed = [
      ssNode("Same Display", { server: "fresh-display.example.com" }),
      {
        name: undefined,
        type: "ss",
        server: "fresh-origin.example.com",
        port: 8388,
        cipher: "aes-128-gcm",
        password: "secret",
        [ORIGIN_NAME_KEY]: "Header Only",
      } as unknown as ParsedNode,
    ];
    const result = mergeParsedSourceNodes(
      [
        ssNode("Same Display", {
          server: "old-display.example.com",
          [ORIGIN_NAME_KEY]: "Old Origin",
        }),
        ssNode("Keep Source Name", {
          server: "old-origin.example.com",
          [ORIGIN_NAME_KEY]: "Header Only",
          [SOURCE_IDS_KEY]: ["source-b", "source-b", "", "source-a"],
        }),
      ],
      parsed,
      [],
      {
        sourceId: "source-a",
        deletedNodes: [
          {
            node: {
              name: "",
              type: "ss",
              server: "blank.example.com",
              port: 8388,
              cipher: "aes-128-gcm",
              password: "secret",
              [ORIGIN_NAME_KEY]: "",
            } as unknown as ParsedNode,
          },
        ],
      }
    );

    expect(result.nodes.map((node) => node.name)).toEqual(["Same Display", "Keep Source Name"]);
    expect(result.nodes[0]).toMatchObject({
      server: "fresh-display.example.com",
      [ORIGIN_NAME_KEY]: "Same Display",
      [SOURCE_IDS_KEY]: ["source-a"],
    });
    expect(result.nodes[1]).toMatchObject({
      server: "fresh-origin.example.com",
      [ORIGIN_NAME_KEY]: "Header Only",
      [SOURCE_IDS_KEY]: ["source-b", "source-a"],
    });
  });
});

describe("subscription response info helpers", () => {
  it("normalizes response metadata and profile update intervals", () => {
    expect(normalizeSubscriptionResponseInfo(null)).toBeNull();
    expect(normalizeSubscriptionResponseInfo({ upload: -1, download: Number.NaN, total: -5 })).toBeNull();
    expect(normalizeSubscriptionResponseInfo({ "plan-name": "A".repeat(250) })?.planName).toHaveLength(200);
    expect(
      normalizeSubscriptionResponseInfo({
        upload: 1,
        download: 2,
        total: 3,
        expire: 1893456000,
        "profile-web-page-url": "https://profile.example.com/path\r\nbad",
        "plan-name": " Premium\nPlan ",
      })
    ).toEqual({
      upload: 1,
      download: 2,
      total: 3,
      expire: 1893456000,
      profileWebPageUrl: "https://profile.example.com/path%20bad",
      planName: "Premium Plan",
    });
    expect(
      normalizeSubscriptionResponseInfo({
        profileWebPageUrl: "https://profile.example.com/path",
        planName: "Plan",
      })
    ).toMatchObject({
      profileWebPageUrl: "https://profile.example.com/path",
      planName: "Plan",
    });
    expect(normalizeSubscriptionResponseInfo({ expire: 1, profileWebPageUrl: "file:///secret" })).toBeNull();
    expect(mergeSubscriptionResponseInfo({ planName: "Base" }, { total: 100 })).toEqual({
      planName: "Base",
      total: 100,
    });
    expect(mergeSubscriptionResponseInfo(null, null)).toEqual({});
    expect(pickSubscriptionResponseInfoFromHeaders()).toEqual({});
    expect(
      pickSubscriptionResponseInfoFromHeaders({
        "profile-web-page-url": "https://profile.example.com/",
        "plan-name": "Plan",
      })
    ).toMatchObject({
      profileWebPageUrl: "https://profile.example.com/",
      planName: "Plan",
    });
    expect(
      resolveClientProfileUpdateIntervalSeconds({
        cacheExpirySeconds: -1,
        autoUpdateIntervalSeconds: Number.NaN,
        isAdmin: true,
      })
    ).toBe(60 * 60);
    expect(getMinAutoUpdateIntervalSeconds(false)).toBe(12 * 60 * 60);
    expect(getMinAutoUpdateIntervalHours(true)).toBe(1);
    expect(getMinAutoUpdateIntervalLabel(false)).toBe("12 小时");
    expect(resolveAutoUpdateIntervalPolicy(false)).toEqual({
      defaultHours: 24,
      minHours: 12,
      stepHours: 1,
      requireIntegerHours: true,
    });
    const localPolicy = resolveAutoUpdateIntervalPolicy(false, {
      defaultHours: 12,
      minHours: 0.1,
      stepHours: 0.1,
      requireIntegerHours: false,
    });
    expect(localPolicy).toEqual({
      defaultHours: 12,
      minHours: 0.1,
      stepHours: 0.1,
      requireIntegerHours: false,
    });
    expect(getAutoUpdateIntervalPolicyMinLabel(localPolicy)).toBe("0.1 小时");
    expect(autoUpdateIntervalHoursToSeconds(0.1)).toBe(360);
    expect(autoUpdateIntervalSecondsToHours(360)).toBe(0.1);
    expect(
      resolveClientProfileUpdateIntervalSeconds({
        cacheExpirySeconds: 3600.9,
        autoUpdateIntervalSeconds: 48 * 60 * 60,
        isAdmin: false,
      })
    ).toBe(48 * 60 * 60);
  });
});
