import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "./definitions";
import { computeGeneratedYaml, computeGeneratedYamlResult } from "./generated-yaml";

const mocks = vi.hoisted(() => ({
  generateClashYaml: vi.fn(),
  stripImportedNodeControlFieldsFromList: vi.fn(),
  resolveNodeNameFilter: vi.fn(),
}));

vi.mock("@subboost/core/generator", () => ({
  generateClashYaml: mocks.generateClashYaml,
}));

vi.mock("@subboost/core/subscription/imported-node-controls", () => ({
  stripImportedNodeControlFieldsFromList: mocks.stripImportedNodeControlFieldsFromList,
}));

vi.mock("@subboost/core/subscription/node-name-filter", () => ({
  DEFAULT_NODE_NAME_FILTER_CONFIG: { enabled: false, excludeRegexes: [] },
  resolveNodeNameFilter: mocks.resolveNodeNameFilter,
}));

function createState(overrides: Record<string, unknown> = {}) {
  return {
    ...structuredClone(initialState),
    ...overrides,
  } as any;
}

describe("computeGeneratedYamlResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateClashYaml.mockReturnValue("generated yaml");
    mocks.stripImportedNodeControlFieldsFromList.mockImplementation((nodes) => nodes);
    mocks.resolveNodeNameFilter.mockImplementation((nodes) => ({
      rawNodes: nodes,
      effectiveNodes: nodes,
      excludedNodes: [],
      rawCount: nodes.length,
      excludedCount: 0,
      effectiveCount: nodes.length,
    }));
  });

  it("passes sanitized nodes and valid proxy providers to the core generator", () => {
    const nodes = [{ name: "Node A", type: "ss", _sourceIds: ["source-1"] }];
    const result = computeGeneratedYamlResult(
      createState({
        nodes,
        sources: [
          {
            id: "source-1",
            type: "url",
            content: " https://example.com/sub.yaml ",
            useProxyProviders: true,
          },
          {
            id: "source-2",
            type: "url",
            content: "ftp://example.com/sub.yaml",
            useProxyProviders: true,
          },
          {
            id: "source-3",
            type: "yaml",
            content: "proxies: []",
            useProxyProviders: true,
          },
        ],
        testUrl: "https://cp.cloudflare.com/generate_204",
        testInterval: 600,
        enabledProxyGroups: ["select", "ai"],
        ruleOrder: ["module:ai"],
      })
    );

    expect(result).toEqual({ yaml: "generated yaml", error: null });
    expect(mocks.resolveNodeNameFilter).toHaveBeenCalledWith(
      nodes,
      expect.objectContaining({ enabled: false, excludeRegexes: [] })
    );
    expect(mocks.stripImportedNodeControlFieldsFromList).toHaveBeenCalledWith(nodes);
    expect(mocks.generateClashYaml).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes,
        proxyProviders: {
          "url_source-1": {
            type: "http",
            url: "https://example.com/sub.yaml",
            interval: 3600,
            path: "./proxy_providers/url_source-1.yaml",
            "health-check": {
              enable: true,
              url: "https://cp.cloudflare.com/generate_204",
              interval: 600,
            },
          },
        },
        userConfig: expect.objectContaining({
          enabledGroups: ["select", "ai"],
          enabledRules: ["select", "ai"],
          ruleOrder: ["module:ai"],
          autoSelectStrategy: "url-test",
        }),
      })
    );
  });

  it("generates from effective nodes while preserving the complete state snapshot", () => {
    const rawNodes = [
      { name: "Keep", type: "ss" },
      { name: "Drop", type: "ss" },
    ];
    const effectiveNodes = [rawNodes[0]];
    mocks.resolveNodeNameFilter.mockReturnValueOnce({
      rawNodes,
      effectiveNodes,
      excludedNodes: [rawNodes[1]],
      rawCount: 2,
      excludedCount: 1,
      effectiveCount: 1,
    });
    const state = createState({
      nodes: rawNodes,
      nodeNameFilter: { enabled: true, excludeRegexes: ["drop"] },
    });

    expect(computeGeneratedYaml(state)).toBe("generated yaml");

    expect(mocks.stripImportedNodeControlFieldsFromList).toHaveBeenCalledWith(effectiveNodes);
    expect(mocks.generateClashYaml).toHaveBeenCalledWith(
      expect.objectContaining({ nodes: effectiveNodes })
    );
    expect(state.nodes).toBe(rawNodes);
  });

  it("hides generated preview when filtering removes every node", () => {
    const rawNodes = [{ name: "Drop", type: "ss" }];
    mocks.resolveNodeNameFilter.mockReturnValueOnce({
      rawNodes,
      effectiveNodes: [],
      excludedNodes: rawNodes,
      rawCount: 1,
      excludedCount: 1,
      effectiveCount: 0,
    });

    const result = computeGeneratedYamlResult(
      createState({
        nodes: rawNodes,
        nodeNameFilter: { enabled: true, excludeRegexes: ["drop"] },
      })
    );

    expect(result).toEqual({ yaml: "", error: null });
    expect(mocks.generateClashYaml).toHaveBeenCalledWith(
      expect.objectContaining({ nodes: [] })
    );
  });

  it("hides generated preview output when there are no nodes or providers", () => {
    const result = computeGeneratedYamlResult(createState());

    expect(result).toEqual({ yaml: "", error: null });
    expect(mocks.generateClashYaml).toHaveBeenCalled();
  });

  it("keeps provider-only preview content visible", () => {
    const yaml = computeGeneratedYaml(
      createState({
        sources: [
          {
            id: "remote",
            type: "url",
            content: "https://example.com/sub.yaml",
            useProxyProviders: true,
          },
        ],
      })
    );

    expect(yaml).toBe("generated yaml");
  });

  it("keeps provider output visible when every ordinary node is excluded", () => {
    const rawNodes = [{ name: "Drop", type: "ss" }];
    mocks.resolveNodeNameFilter.mockReturnValueOnce({
      rawNodes,
      effectiveNodes: [],
      excludedNodes: rawNodes,
      rawCount: 1,
      excludedCount: 1,
      effectiveCount: 0,
    });

    const yaml = computeGeneratedYaml(
      createState({
        nodes: rawNodes,
        nodeNameFilter: { enabled: true, excludeRegexes: ["drop"] },
        sources: [
          {
            id: "remote",
            type: "url",
            content: "https://example.com/sub.yaml",
            useProxyProviders: true,
          },
        ],
      })
    );

    expect(yaml).toBe("generated yaml");
    expect(mocks.generateClashYaml).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: [],
        proxyProviders: expect.objectContaining({ url_remote: expect.any(Object) }),
      })
    );
  });

  it("formats generator failures for UI display", () => {
    mocks.generateClashYaml.mockImplementationOnce(() => {
      throw new Error("dns yaml failed");
    });
    expect(computeGeneratedYamlResult(createState({ nodes: [{ name: "Node A" }] }))).toEqual({
      yaml: "",
      error: "dns yaml failed",
    });

    mocks.generateClashYaml.mockImplementationOnce(() => {
      throw "bad";
    });
    expect(computeGeneratedYamlResult(createState({ nodes: [{ name: "Node A" }] }))).toEqual({
      yaml: "",
      error: "生成配置失败",
    });
  });

  it("formats node-filter failures for UI display", () => {
    mocks.resolveNodeNameFilter.mockImplementationOnce(() => {
      throw new Error("第 1 行：正则表达式无效");
    });

    expect(computeGeneratedYamlResult(createState({ nodes: [{ name: "Node A" }] }))).toEqual({
      yaml: "",
      error: "第 1 行：正则表达式无效",
    });
    expect(mocks.generateClashYaml).not.toHaveBeenCalled();
  });
});
