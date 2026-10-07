import { describe, expect, it } from "vitest";
import type { ParsedNode } from "@subboost/core/types/node";
import { initialState } from "../definitions";
import { createNodeActions } from "./node-actions";

function node(name: string, extra: Record<string, unknown> = {}): ParsedNode {
  return {
    name,
    type: "ss",
    server: `${name.toLowerCase().replaceAll(" ", "-")}.example.com`,
    port: 443,
    cipher: "aes-128-gcm",
    password: "secret",
    ...extra,
  } as unknown as ParsedNode;
}

function createHarness(overrides: Record<string, unknown> = {}) {
  let state = {
    ...structuredClone(initialState),
    ...overrides,
  } as any;

  const applyPatch = (patch: any) => {
    if (!patch || patch === state) return;
    state = { ...state, ...patch };
  };

  const set = (partial: any) => {
    applyPatch(typeof partial === "function" ? partial(state) : partial);
  };

  const setAndGenerateConfig = (updater: any) => {
    applyPatch(updater(state));
  };

  const actions = createNodeActions(set, () => state, setAndGenerateConfig);
  return { actions, getState: () => state };
}

describe("createNodeActions", () => {
  it("removes nodes with restore metadata and restores them later", () => {
    const { actions, getState } = createHarness({
      nodes: [
        node("Node A", { _originName: "Origin A" }),
        node("Node B"),
      ],
      listenerPorts: { "Node A": 41000, "Node B": 41001 },
      dialerProxyGroups: [
        {
          id: "dialer-1",
          name: "Relay",
          relayNodes: ["DIRECT", "Node A", "Node B"],
          targetNodes: ["Node A", "Node B"],
        },
      ],
    });

    actions.removeNode("Node A");

    expect(getState().nodes.map((item: ParsedNode) => item.name)).toEqual(["Node B"]);
    expect(getState().deletedNodeNames).toEqual(["Origin A"]);
    expect(getState().deletedNodes).toEqual([
      expect.objectContaining({
        originName: "Origin A",
        name: "Node A",
        listenerPort: 41000,
        dialerRelayGroupIds: ["dialer-1"],
        dialerTargetGroupIds: ["dialer-1"],
      }),
    ]);
    expect(getState().listenerPorts).toEqual({ "Node B": 41001 });
    expect(getState().dialerProxyGroups[0]).toMatchObject({
      relayNodes: ["DIRECT", "Node B"],
      targetNodes: ["Node B"],
    });

    actions.restoreDeletedNode("Origin A");

    expect(getState().nodes.map((item: ParsedNode) => item.name)).toEqual(["Node B", "Node A"]);
    expect(getState().deletedNodeNames).toEqual([]);
    expect(getState().deletedNodes).toEqual([]);
    expect(getState().listenerPorts).toEqual({ "Node B": 41001, "Node A": 41000 });
    expect(getState().dialerProxyGroups[0]).toMatchObject({
      relayNodes: ["DIRECT", "Node B", "Node A"],
      targetNodes: ["Node B", "Node A"],
    });
  });

  it("keeps separate deleted-node records for duplicate origin names", () => {
    const { actions, getState } = createHarness({
      nodes: [
        node("SOCKS-same.example.com:1080", {
          _originName: "SOCKS-same.example.com:1080",
          password: "one",
        }),
        node("SOCKS-same.example.com:1080 (2)", {
          _originName: "SOCKS-same.example.com:1080",
          password: "two",
        }),
      ],
    });

    actions.removeNode("SOCKS-same.example.com:1080");
    actions.removeNode("SOCKS-same.example.com:1080 (2)");

    expect(getState().deletedNodeNames).toEqual(["SOCKS-same.example.com:1080"]);
    expect(getState().deletedNodes).toEqual([
      expect.objectContaining({
        originName: "SOCKS-same.example.com:1080",
        name: "SOCKS-same.example.com:1080",
        node: expect.objectContaining({ password: "one" }),
      }),
      expect.objectContaining({
        originName: "SOCKS-same.example.com:1080",
        name: "SOCKS-same.example.com:1080 (2)",
        node: expect.objectContaining({ password: "two" }),
      }),
    ]);
  });

  it("handles missing remove targets and restore metadata without cached nodes", () => {
    const { actions, getState } = createHarness({
      nodes: [node("Existing")],
      deletedNodeNames: ["Origin B", "Stale"],
      deletedNodes: [
        { originName: "Origin B", name: "Node B" },
        { originName: "Existing", name: "Existing", node: node("Existing") },
      ],
    });

    actions.removeNode(" Missing ");
    expect(getState().nodes.map((item: ParsedNode) => item.name)).toEqual(["Existing"]);
    expect(getState().deletedNodeNames).toContain("Missing");
    expect(getState().deletedNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ originName: "Missing", name: " Missing ", node: undefined }),
      ])
    );

    actions.restoreDeletedNode("Origin B");
    expect(getState().deletedNodeNames).toEqual(["Stale", "Missing"]);
    expect(getState().deletedNodes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ originName: "Origin B" })])
    );

    actions.restoreDeletedNode("Existing");
    expect(getState().nodes.map((item: ParsedNode) => item.name)).toEqual(["Existing"]);
    expect(getState().deletedNodeNames).toEqual(["Stale", "Missing"]);

    const beforeBlankRestore = getState();
    actions.restoreDeletedNode(" ");
    expect(getState()).toBe(beforeBlankRestore);

    const beforeNoMatchRestore = getState();
    actions.restoreDeletedNode("Not Recorded");
    expect(getState()).toBe(beforeNoMatchRestore);
  });

  it("restores cached nodes with name collisions and partial group metadata", () => {
    const { actions, getState } = createHarness({
      nodes: [node("Existing")],
      deletedNodeNames: ["Origin C"],
      deletedNodes: [
        {
          originName: "Origin C",
          name: "Existing",
          node: node("Existing"),
          listenerPort: "not-a-number",
          dialerRelayGroupIds: ["relay-only"],
          dialerTargetGroupIds: ["target-only"],
        },
      ],
      dialerProxyGroups: [
        { id: "relay-only", name: "Relay", relayNodes: ["A"], targetNodes: ["B"] },
        { id: "target-only", name: "Target", relayNodes: ["C"], targetNodes: ["D"] },
        { id: "untouched", name: "Untouched", relayNodes: ["E"], targetNodes: ["F"] },
      ],
    });

    actions.restoreDeletedNode("Origin C");

    expect(getState().nodes.map((item: ParsedNode) => item.name)).toEqual(["Existing", "Existing (2)"]);
    expect(getState().listenerPorts).toEqual({});
    expect(getState().dialerProxyGroups).toEqual([
      expect.objectContaining({ id: "relay-only", relayNodes: ["A", "Existing (2)"], targetNodes: ["B"] }),
      expect.objectContaining({ id: "target-only", relayNodes: ["C"], targetNodes: ["D", "Existing (2)"] }),
      expect.objectContaining({ id: "untouched", relayNodes: ["E"], targetNodes: ["F"] }),
    ]);
  });

  it("restores source-derived names and keeps dependent references in sync", () => {
    const { actions, getState } = createHarness({
      nodes: [
        node("Custom A", { _originName: "Origin A", _sourceIds: ["source-1"] }),
        node("Other"),
      ],
      sources: [
        {
          id: "source-1",
          type: "url",
          content: "https://example.com/sub",
          lastParsedTag: "TAG",
          lastParsedNameTemplate: "{tag}-{name}",
        },
      ],
      listenerPorts: { "Custom A": 42000 },
      dialerProxyGroups: [
        {
          id: "dialer-1",
          name: "Relay",
          relayNodes: ["Custom A", "TAG-Origin A", "Other"],
          targetNodes: ["Custom A", "TAG-Origin A"],
        },
      ],
    });

    actions.restoreNodeName("Custom A");

    expect(getState().nodes.map((item: ParsedNode) => item.name)).toEqual(["TAG-Origin A", "Other"]);
    expect(getState().listenerPorts).toEqual({ "TAG-Origin A": 42000 });
    expect(getState().dialerProxyGroups[0]).toMatchObject({
      relayNodes: ["TAG-Origin A", "Other"],
      targetNodes: ["TAG-Origin A"],
    });

    actions.renameNode("TAG-Origin A", "Other");

    expect(getState().nodes.map((item: ParsedNode) => item.name)).toEqual(["Other (2)", "Other"]);
    expect(getState().nodes[0]).toMatchObject({ _originName: "Origin A" });
    expect(getState().listenerPorts).toEqual({ "Other (2)": 42000 });
    expect(getState().dialerProxyGroups[0]).toMatchObject({
      relayNodes: ["Other (2)", "Other"],
      targetNodes: ["Other (2)"],
    });

    const beforeIgnored = getState();
    actions.restoreNodeName("missing");
    actions.restoreNodeName("Other");
    actions.renameNode("Other", "Other");
    actions.renameNode("Other", " ");
    expect(getState()).toBe(beforeIgnored);
  });

  it("restores names from source fallback metadata or bare origin names", () => {
    const { actions, getState } = createHarness({
      nodes: [
        node("Custom A", { _originName: "Origin A", _sourceIds: ["source-1"] }),
        node("Custom B", { _originName: "Origin B", _sourceIds: ["source-2"] }),
        node("Custom C", { _originName: "Origin C", _sourceIds: "bad" }),
      ],
      sources: [
        {
          id: "source-1",
          type: "url",
          content: "https://example.com/sub",
          tag: "Fallback",
          nameTemplate: "{tag}/{name}",
        },
        {
          id: "source-2",
          type: "url",
          content: "https://example.com/blank",
          tag: "   ",
          nameTemplate: "{tag}-{name}",
        },
      ],
    });

    actions.restoreNodeName("Custom A");
    actions.restoreNodeName("Custom B");
    actions.restoreNodeName("Custom C");

    expect(getState().nodes.map((item: ParsedNode) => item.name)).toEqual([
      "Fallback/Origin A",
      "Origin B",
      "Origin C",
    ]);
  });

  it("moves nodes and applies absolute ordering with bounds checks", () => {
    const { actions, getState } = createHarness({
      nodes: [node("A"), node("B"), node("C")],
    });

    actions.moveNode("B", "up");
    expect(getState().nodes.map((item: ParsedNode) => item.name)).toEqual(["B", "A", "C"]);

    actions.moveNode("A", "down");
    expect(getState().nodes.map((item: ParsedNode) => item.name)).toEqual(["B", "C", "A"]);

    actions.moveNode("B", "up");
    expect(getState().nodes.map((item: ParsedNode) => item.name)).toEqual(["B", "C", "A"]);

    actions.setNodeOrder("C", 1.8);
    expect(getState().nodes.map((item: ParsedNode) => item.name)).toEqual(["C", "B", "A"]);

    actions.setNodeOrder("C", -3);
    actions.setNodeOrder("A", 99);
    expect(getState().nodes.map((item: ParsedNode) => item.name)).toEqual(["C", "B", "A"]);

    actions.setNodeOrder("missing", 2);
    actions.setNodeOrder("B", Number.NaN);
    expect(getState().nodes.map((item: ParsedNode) => item.name)).toEqual(["C", "B", "A"]);
  });

  it("reorders only scoped node slots while preserving hidden node positions", () => {
    const { actions, getState } = createHarness({
      nodes: [
        node("A"),
        node("Hidden 1"),
        node("B"),
        node("Hidden 2"),
        node("C"),
      ],
    });
    const effectiveNodeNames = ["A", "B", "C"];

    actions.setNodeOrder("C", 1, effectiveNodeNames);
    expect(getState().nodes.map((item: ParsedNode) => item.name)).toEqual([
      "C",
      "Hidden 1",
      "A",
      "Hidden 2",
      "B",
    ]);

    actions.setNodeOrder("C", 3, effectiveNodeNames);
    expect(getState().nodes.map((item: ParsedNode) => item.name)).toEqual([
      "A",
      "Hidden 1",
      "B",
      "Hidden 2",
      "C",
    ]);

    actions.setNodeOrder("Hidden 1", 2, effectiveNodeNames);
    actions.setNodeOrder("A", 2, []);
    expect(getState().nodes.map((item: ParsedNode) => item.name)).toEqual([
      "A",
      "Hidden 1",
      "B",
      "Hidden 2",
      "C",
    ]);
  });

  it("bulk renames nodes and listener ports without duplicate names", () => {
    const { actions, getState } = createHarness({
      nodes: [node("A"), node("B"), node("C"), node("X")],
      listenerPorts: { A: 1000, B: 2000, C: 3000 },
      dialerProxyGroups: [
        {
          id: "dialer-1",
          name: "Relay",
          relayNodes: ["A", "B", "C", "X"],
          targetNodes: ["A", "B", "X"],
        },
      ],
    });

    actions.bulkRenameNodes([
      { oldName: "B", newName: "X" },
      { oldName: "A", newName: "X" },
      { oldName: "missing", newName: "Ignored" },
      { oldName: "C", newName: "C" },
    ]);

    expect(getState().nodes.map((item: ParsedNode) => item.name)).toEqual(["X (2)", "X (3)", "C", "X"]);
    expect(getState().listenerPorts).toEqual({ "X (2)": 1000, "X (3)": 2000, C: 3000 });
    expect(getState().dialerProxyGroups[0]).toMatchObject({
      relayNodes: ["X (2)", "X (3)", "C", "X"],
      targetNodes: ["X (2)", "X (3)", "X"],
    });

    const beforeNoop = getState();
    actions.bulkRenameNodes([]);
    actions.bulkRenameNodes(null as never);
    actions.bulkRenameNodes([
      { oldName: "missing", newName: "Ignored" },
      { oldName: "", newName: "Ignored" },
      { oldName: "C", newName: 123 as never },
      { oldName: "C", newName: "C" },
    ]);
    expect(getState()).toBe(beforeNoop);
  });

  it("bulk renames references when listener port state is not an object", () => {
    const { actions, getState } = createHarness({
      nodes: [node("A"), node("B"), node("X")],
      listenerPorts: null,
      dialerProxyGroups: [
        { id: "dialer-1", name: "Relay", relayNodes: ["A", "X"], targetNodes: ["A", "X"] },
      ],
    });

    actions.bulkRenameNodes([{ oldName: "A", newName: "X" }]);

    expect(getState().nodes.map((item: ParsedNode) => item.name)).toEqual(["X (2)", "B", "X"]);
    expect(getState().listenerPorts).toBeNull();
    expect(getState().dialerProxyGroups[0]).toMatchObject({
      relayNodes: ["X (2)", "X"],
      targetNodes: ["X (2)", "X"],
    });
  });

  it("skips malformed bulk rename entries and handles renames without listener ports", () => {
    const { actions, getState } = createHarness({
      nodes: [
        node("A", { _originName: " Origin A " }),
        node("B"),
      ],
      listenerPorts: {},
      dialerProxyGroups: [{ id: "dialer-1", name: "Relay", relayNodes: ["A", "B"], targetNodes: ["A"] }],
    });

    actions.bulkRenameNodes([
      null as never,
      { oldName: 1 as never, newName: "Ignored" },
      { oldName: "Missing", newName: "Ignored" },
      { oldName: "A", newName: "B" },
    ]);

    expect(getState().nodes.map((item: ParsedNode) => item.name)).toEqual(["B (2)", "B"]);
    expect(getState().nodes[0]).toMatchObject({ _originName: " Origin A " });
    expect(getState().listenerPorts).toEqual({});
    expect(getState().dialerProxyGroups[0]).toMatchObject({
      relayNodes: ["B (2)", "B"],
      targetNodes: ["B (2)"],
    });
  });

  it("sets listener ports one at a time or in sanitized batches", () => {
    const { actions, getState } = createHarness({
      listenerPorts: { A: 1000, B: 2000, C: 3000 },
    });

    actions.setListenerPort(" A ", 1234);
    actions.setListenerPort("B", 70000);
    actions.setListenerPort("", 5000);
    actions.setListenerPort("A", 1234);
    actions.setListenerPort("Missing", null);
    expect(getState().listenerPorts).toEqual({ A: 1234, B: 2000, C: 3000 });

    actions.setListenerPort("A", null);
    expect(getState().listenerPorts).toEqual({ B: 2000, C: 3000 });

    actions.bulkSetListenerPorts({
      A: null,
      B: 3000,
      C: 4000,
      D: 5000,
      bad: 0,
      Duplicate: 3000,
    });
    expect(getState().listenerPorts).toEqual({ B: 3000, C: 4000, D: 5000 });

    const beforeInvalidBulk = getState();
    actions.bulkSetListenerPorts(null as never);
    actions.bulkSetListenerPorts({ " ": 1000, Bad: "nope" as never });
    actions.bulkSetListenerPorts({ Duplicate: 3000 });
    expect(getState()).toBe(beforeInvalidBulk);
  });

  it("clears all node-related generated state", () => {
    const { actions, getState } = createHarness({
      nodes: [node("A")],
      deletedNodeNames: ["Old"],
      deletedNodes: [{ originName: "Old", name: "Old" }],
      parseErrors: ["bad"],
      generatedYaml: "mixed-port: 7890",
      generatedYamlError: "failed",
      listenerPorts: { A: 1000 },
    });

    actions.clearNodes();

    expect(getState()).toMatchObject({
      nodes: [],
      deletedNodeNames: [],
      deletedNodes: [],
      parseErrors: [],
      generatedYaml: "",
      generatedYamlError: null,
      listenerPorts: {},
    });
  });
});
