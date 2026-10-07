import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../definitions";
import { createDialerActions } from "./dialer-actions";

function createHarness(overrides: Record<string, unknown> = {}) {
  let state = {
    ...structuredClone(initialState),
    ...overrides,
  } as any;

  const applyPatch = (patch: any) => {
    if (!patch || patch === state) return;
    state = { ...state, ...patch };
  };

  const setAndGenerateConfig = (updater: any) => {
    applyPatch(updater(state));
  };

  const actions = createDialerActions(() => undefined, () => state, setAndGenerateConfig);
  return { actions, getState: () => state };
}

describe("createDialerActions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds, updates, and removes dialer proxy groups", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1700000000001).mockReturnValueOnce(1700000000002);
    const { actions, getState } = createHarness({
      dialerProxyGroups: [
        {
          id: "dialer-1",
          name: "Existing",
          enabled: true,
          relayNodes: ["Relay A"],
          targetNodes: ["Target A"],
        },
      ],
    });

    actions.addDialerProxyGroup({
      name: "Default Enabled",
      relayNodes: [],
      targetNodes: [],
    } as any);
    actions.addDialerProxyGroup({
      name: "Explicit Disabled",
      enabled: false,
      relayNodes: ["Relay B"],
      targetNodes: ["Target B"],
    } as any);

    expect(getState().dialerProxyGroups).toEqual([
      {
        id: "dialer-1",
        name: "Existing",
        enabled: true,
        relayNodes: ["Relay A"],
        targetNodes: ["Target A"],
      },
      {
        id: "dialer-1700000000001",
        name: "Default Enabled",
        enabled: true,
        relayNodes: [],
        targetNodes: [],
      },
      {
        id: "dialer-1700000000002",
        name: "Explicit Disabled",
        enabled: false,
        relayNodes: ["Relay B"],
        targetNodes: ["Target B"],
      },
    ]);

    actions.updateDialerProxyGroup("dialer-1", {
      name: "Renamed",
      enabled: false,
    });
    actions.updateDialerProxyGroup("missing", { name: "Ignored" });

    expect(getState().dialerProxyGroups[0]).toMatchObject({
      id: "dialer-1",
      name: "Renamed",
      enabled: false,
    });

    actions.removeDialerProxyGroup("dialer-1700000000001");
    expect(getState().dialerProxyGroups.map((group: { id: string }) => group.id)).toEqual([
      "dialer-1",
      "dialer-1700000000002",
    ]);
  });

  it("removes the group listener binding when deleting a dialer proxy group", () => {
    const { actions, getState } = createHarness({
      dialerProxyGroups: [
        { id: "dialer-1", name: "Relay", enabled: true, relayNodes: [], targetNodes: [] },
      ],
      groupListeners: [
        { id: "gl-1", target: { kind: "dialer", id: "dialer-1" }, port: 7891 },
        { id: "gl-2", target: { kind: "custom", id: "custom-1" }, port: 7892 },
      ],
    });

    actions.removeDialerProxyGroup("dialer-1");

    expect(getState().dialerProxyGroups).toEqual([]);
    expect(getState().groupListeners).toEqual([
      { id: "gl-2", target: { kind: "custom", id: "custom-1" }, port: 7892 },
    ]);
  });

  it("adds and removes relay or target nodes without duplicates", () => {
    const { actions, getState } = createHarness({
      dialerProxyGroups: [
        {
          id: "dialer-1",
          name: "Relay",
          enabled: true,
          relayNodes: ["Relay A"],
          targetNodes: ["Target A"],
        },
        {
          id: "dialer-2",
          name: "Untouched",
          enabled: true,
          relayNodes: ["Relay Z"],
          targetNodes: ["Target Z"],
        },
      ],
    });

    actions.addNodeToDialerGroup("dialer-1", "Relay B", true);
    actions.addNodeToDialerGroup("dialer-1", "Relay B", true);
    actions.addNodeToDialerGroup("dialer-1", "Target B", false);
    actions.addNodeToDialerGroup("dialer-1", "Target B", false);
    actions.addNodeToDialerGroup("missing", "Ignored", true);

    expect(getState().dialerProxyGroups[0]).toMatchObject({
      relayNodes: ["Relay A", "Relay B"],
      targetNodes: ["Target A", "Target B"],
    });
    expect(getState().dialerProxyGroups[1]).toMatchObject({
      relayNodes: ["Relay Z"],
      targetNodes: ["Target Z"],
    });

    actions.removeNodeFromDialerGroup("dialer-1", "Relay A", true);
    actions.removeNodeFromDialerGroup("dialer-1", "Target A", false);
    actions.removeNodeFromDialerGroup("missing", "Ignored", false);

    expect(getState().dialerProxyGroups[0]).toMatchObject({
      relayNodes: ["Relay B"],
      targetNodes: ["Target B"],
    });
    expect(getState().dialerProxyGroups[1]).toMatchObject({
      relayNodes: ["Relay Z"],
      targetNodes: ["Target Z"],
    });
  });
});
