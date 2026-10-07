import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEMPLATES } from "@subboost/core/templates";
import { DEFAULT_SUBBOOST_CONFIG } from "@subboost/core/config/defaults";
import { DEFAULT_NODE_NAME_FILTER_CONFIG } from "@subboost/core/subscription/node-name-filter";

const mocks = vi.hoisted(() => ({
  importSource: vi.fn(),
  sourceImport: {} as { importSource?: ReturnType<typeof vi.fn> } | null,
}));

vi.mock("@subboost/ui/product/api-adapter", () => ({
  getActiveProductApiAdapter: () => ({
    sourceImport: mocks.sourceImport,
  }),
}));

import {
  DEFAULT_BASE_CONFIG_YAML,
  PRESET_RELAY_NAMES,
  fetchUrlContentInBrowser,
  initialState,
} from "./definitions";

describe("config store definitions", () => {
  beforeEach(() => {
    mocks.importSource.mockReset();
    mocks.sourceImport = { importSource: mocks.importSource };
    mocks.importSource.mockResolvedValue({
      content: "proxies: []",
      headers: {},
    });
  });

  it("keeps initial config defaults aligned with core defaults", () => {
    expect(initialState.sources).toEqual([
      { id: "1", type: "url", content: "" },
      { id: "2", type: "yaml", content: "" },
      { id: "3", type: "nodes", content: "" },
    ]);
    expect(initialState.template).toBe("minimal");
    expect(initialState.enabledProxyGroups).toBe(TEMPLATES.minimal.groups);
    expect(initialState.mixedPort).toBe(DEFAULT_SUBBOOST_CONFIG.mixedPort);
    expect(initialState.allowLan).toBe(DEFAULT_SUBBOOST_CONFIG.allowLan);
    expect(initialState.testUrl).toBe(DEFAULT_SUBBOOST_CONFIG.testUrl);
    expect(initialState.testInterval).toBe(DEFAULT_SUBBOOST_CONFIG.testInterval);
    expect(initialState.ruleProviderBaseUrl).toBe(DEFAULT_SUBBOOST_CONFIG.ruleProviderBaseUrl);
    expect(initialState.nodeNameFilter).toEqual(DEFAULT_NODE_NAME_FILTER_CONFIG);
    expect(initialState.nodeNameFilter).not.toBe(DEFAULT_NODE_NAME_FILTER_CONFIG);
    expect(initialState.generatedYaml).toBe("");
    expect(initialState.historyIndex).toBe(-1);
  });

  it("exports relay names and the current base-config default", () => {
    expect(PRESET_RELAY_NAMES).toContain("🇺🇸 美国中转");
    expect(PRESET_RELAY_NAMES).toContain("🇭🇰 香港中转");
    expect(DEFAULT_BASE_CONFIG_YAML).toContain("# 配置文件管理");
  });

  it("validates URL input before calling the active product adapter", async () => {
    await expect(fetchUrlContentInBrowser("not a url")).rejects.toThrow("无效的 url 格式");
    await expect(fetchUrlContentInBrowser("ftp://example.com/sub")).rejects.toThrow("只支持 HTTP/HTTPS url");
    await expect(
      fetchUrlContentInBrowser("https://example.com/sub", { userinfoUrl: "not a url" })
    ).rejects.toThrow("无效的流量信息 url 格式");

    expect(mocks.importSource).not.toHaveBeenCalled();
  });

  it("requires a configured source import adapter", async () => {
    mocks.sourceImport = null;

    await expect(fetchUrlContentInBrowser("https://example.com/sub")).rejects.toThrow("当前应用未配置 URL 导入服务");
  });

  it("normalizes adapter payload headers and prefetched parse results", async () => {
    const parsedNode = {
      name: "Remote",
      type: "ss",
      server: "remote.example.com",
      port: 443,
    };
    mocks.importSource.mockResolvedValueOnce({
      content: "remote content",
      headers: {
        "Subscription-Userinfo": "upload=1; download=2; total=3; expire=4",
        " ": "ignored",
        "profile-web-page-url": 12,
      },
      parseResult: {
        nodes: [parsedNode, null, "bad"],
        errors: ["minor warning", 404],
      },
    });

    await expect(
      fetchUrlContentInBrowser(" https://example.com/sub ", {
        userinfoUrl: "https://example.com/userinfo",
        userinfoUserAgent: " Clash.Meta ",
      })
    ).resolves.toEqual({
      content: "remote content",
      headers: {
        "subscription-userinfo": "upload=1; download=2; total=3; expire=4",
      },
      parseResult: {
        nodes: [parsedNode],
        errors: ["minor warning"],
        totalParsed: 1,
        totalFailed: 1,
      },
    });
    expect(mocks.importSource).toHaveBeenCalledWith({
      url: "https://example.com/sub",
      userinfoUrl: "https://example.com/userinfo",
      userinfoUserAgent: "Clash.Meta",
    });
  });

  it("wraps unknown adapter failures with a public error message", async () => {
    mocks.importSource.mockRejectedValueOnce("boom");

    await expect(fetchUrlContentInBrowser("https://example.com/sub")).rejects.toThrow("获取 url 失败");
  });
});
