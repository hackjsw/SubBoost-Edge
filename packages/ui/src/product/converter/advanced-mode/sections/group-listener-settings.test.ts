import { describe, expect, it } from "vitest";
import {
  collectUsedListenerPorts,
  findGroupListenerBinding,
  resolveEffectiveMixedPort,
  validateGroupListenerPort,
  type GroupListenerConflictState,
} from "./group-listener-settings";

const TARGET = { kind: "module" as const, id: "auto" };

function state(patch: Partial<GroupListenerConflictState> = {}): GroupListenerConflictState {
  return {
    dnsYaml: "",
    mixedPort: 7890,
    listenerPorts: {},
    groupListeners: [],
    ...patch,
  };
}

describe("resolveEffectiveMixedPort", () => {
  it("prefers the base YAML override over the settings value", () => {
    expect(resolveEffectiveMixedPort("mixed-port: 9999\n", 7890)).toBe(9999);
  });

  it("returns undefined when explicit base YAML omits mixed-port", () => {
    expect(resolveEffectiveMixedPort("allow-lan: false\n", 7890)).toBeUndefined();
  });

  it("falls back to the settings value without base YAML", () => {
    expect(resolveEffectiveMixedPort("", 7890)).toBe(7890);
  });
});

describe("validateGroupListenerPort", () => {
  it("covers all four conflict sources", () => {
    const conflictState = state({
      dnsYaml: "mixed-port: 9000\nlisteners:\n  - name: base-in\n    type: mixed\n    port: 9100\n",
      listenerPorts: { Node: 9200 },
      groupListeners: [{ id: "gl-1", target: { kind: "custom", id: "c1" }, port: 9300 }],
    });

    expect(validateGroupListenerPort("9000", conflictState, TARGET).error).toMatch(/mixed-port/);
    expect(validateGroupListenerPort("9100", conflictState, TARGET).error).toMatch(/listeners/);
    expect(validateGroupListenerPort("9200", conflictState, TARGET).error).toMatch(/节点监听端口/);
    expect(validateGroupListenerPort("9300", conflictState, TARGET).error).toMatch(/其他策略组/);
    expect(validateGroupListenerPort("9400", conflictState, TARGET)).toEqual({ port: 9400, error: null });
  });

  it("excludes the binding being edited from self-conflict", () => {
    const conflictState = state({
      groupListeners: [{ id: "gl-1", target: TARGET, port: 7891 }],
    });
    expect(validateGroupListenerPort("7891", conflictState, TARGET).error).toBeNull();
  });

  it("rejects empty and out-of-range input", () => {
    expect(validateGroupListenerPort("", state(), TARGET).error).toMatch(/请输入/);
    expect(validateGroupListenerPort("0", state(), TARGET).error).toMatch(/1-65535/);
    expect(validateGroupListenerPort("70000", state(), TARGET).error).toMatch(/1-65535/);
    expect(validateGroupListenerPort("abc", state(), TARGET).error).toMatch(/1-65535/);
  });

  it("skips conflict checks but keeps format checks when checkConflict is false", () => {
    const conflictState = state({ mixedPort: 7890 });

    expect(validateGroupListenerPort("7890", conflictState, TARGET).error).toMatch(/冲突/);
    expect(validateGroupListenerPort("7890", conflictState, TARGET, { checkConflict: false })).toEqual({
      port: 7890,
      error: null,
    });
    expect(validateGroupListenerPort("abc", conflictState, TARGET, { checkConflict: false }).error).toMatch(/1-65535/);
    expect(validateGroupListenerPort("", conflictState, TARGET, { checkConflict: false }).error).toMatch(/请输入/);
  });
});

describe("collectUsedListenerPorts / findGroupListenerBinding", () => {
  it("labels the first source that claims a port", () => {
    const used = collectUsedListenerPorts(state({ mixedPort: 7890 }));
    expect(used.get(7890)).toBe("全局 mixed-port");
  });

  it("ignores disabled bindings as conflict sources, matching generator behavior", () => {
    const used = collectUsedListenerPorts(
      state({
        groupListeners: [
          { id: "gl-1", target: { kind: "custom", id: "paused" }, port: 9300, enabled: false },
          { id: "gl-2", target: { kind: "custom", id: "active" }, port: 9400 },
        ],
      })
    );
    expect(used.get(9300)).toBeUndefined();
    expect(used.get(9400)).toBe("其他策略组的监听端口");
  });

  it("matches bindings by target kind and id", () => {
    const bindings = [
      { id: "gl-1", target: { kind: "custom" as const, id: "x" }, port: 1 },
      { id: "gl-2", target: { kind: "module" as const, id: "auto" }, port: 2 },
    ];
    expect(findGroupListenerBinding(bindings, TARGET)?.id).toBe("gl-2");
    expect(findGroupListenerBinding(bindings, { kind: "dialer", id: "auto" })).toBeUndefined();
  });
});
