import { describe, expect, it, vi } from "vitest";
import { createGroupListenerActions } from "./group-listener-actions";
import type { ConfigState } from "../definitions";

const TARGET = { kind: "module" as const, id: "auto" };

function run(groupListeners: ConfigState["groupListeners"], ...args: Parameters<ReturnType<typeof createGroupListenerActions>["setGroupListener"]>) {
  let patch: Partial<ConfigState> = {};
  const setAndGenerateConfig = vi.fn((updater: (state: any) => any) => {
    patch = updater({ groupListeners });
  });
  const actions = createGroupListenerActions(vi.fn() as never, vi.fn() as never, setAndGenerateConfig as never);
  actions.setGroupListener(...args);
  return patch;
}

describe("setGroupListener", () => {
  it("adds a new binding with default flags omitted", () => {
    const patch = run([], TARGET, { port: 7891, enabled: true, allowLan: false });
    expect(patch.groupListeners).toEqual([
      expect.objectContaining({ target: TARGET, port: 7891 }),
    ]);
    expect(patch.groupListeners?.[0]).not.toHaveProperty("enabled");
    expect(patch.groupListeners?.[0]).not.toHaveProperty("allowLan");
  });

  it("updates an existing binding in place, keeping its id and order", () => {
    const existing = [
      { id: "gl-a", target: { kind: "custom" as const, id: "c1" }, port: 7000 },
      { id: "gl-b", target: TARGET, port: 7891 },
    ];
    const patch = run(existing, TARGET, { port: 7892, enabled: false, allowLan: true });
    expect(patch.groupListeners?.map((b) => b.id)).toEqual(["gl-a", "gl-b"]);
    expect(patch.groupListeners?.[1]).toEqual({
      id: "gl-b",
      target: TARGET,
      port: 7892,
      enabled: false,
      allowLan: true,
    });
  });

  it("removes the binding for null config and no-ops when absent", () => {
    const existing = [{ id: "gl-b", target: TARGET, port: 7891 }];
    expect(run(existing, TARGET, null).groupListeners).toEqual([]);
    expect(run([], TARGET, null)).toEqual({});
  });

  it("collapses duplicate bindings for the same target into one", () => {
    const existing = [
      { id: "gl-1", target: TARGET, port: 7891 },
      { id: "gl-2", target: TARGET, port: 7892 },
    ];
    const patch = run(existing, TARGET, { port: 7893, enabled: true, allowLan: false });
    expect(patch.groupListeners).toHaveLength(1);
    expect(patch.groupListeners?.[0]).toMatchObject({ id: "gl-1", port: 7893 });
  });
});
