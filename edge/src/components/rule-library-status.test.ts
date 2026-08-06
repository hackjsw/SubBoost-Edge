import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RuleCatalogStatusResponse } from "@edge/lib/rule-catalog-status";
import {
  fetchRuleCatalogStatus,
  refreshRuleCatalogStatus,
  RuleLibraryStatusView,
} from "./rule-library-status";

const status: RuleCatalogStatusResponse = {
  source: "remote",
  sourceLabel: "MetaCubeX/meta-rules-dat",
  sourceUrl: "https://github.com/MetaCubeX/meta-rules-dat",
  geositeCount: 120,
  geoipCount: 30,
  totalRules: 150,
  fetchedAt: Date.parse("2026-08-06T03:17:00.000Z"),
  expiresAt: Date.parse("2026-08-07T03:17:00.000Z"),
  schedule: "17 3 * * *",
  nextScheduledAt: Date.parse("2026-08-07T03:17:00.000Z"),
};

function renderView(overrides: Partial<React.ComponentProps<typeof RuleLibraryStatusView>> = {}) {
  return renderToStaticMarkup(
    React.createElement(RuleLibraryStatusView, {
      status,
      loading: false,
      error: null,
      refreshing: false,
      onRetry: vi.fn(),
      onRefresh: vi.fn(),
      ...overrides,
    })
  );
}

describe("RuleLibraryStatus", () => {
  it("renders a stable loading panel", () => {
    const html = renderView({ status: null, loading: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("正在加载规则库状态");
    expect(html).toContain("min-h-[176px]");
  });

  it("renders source, counts, timestamps, and the manual sync command", () => {
    const html = renderView();
    expect(html).toContain("bg-white");
    expect(html).toContain("text-[#172321]");
    expect(html).not.toContain("bg-[#141414]");
    expect(html).toContain("远端索引");
    expect(html).toContain("MetaCubeX/meta-rules-dat");
    expect(html).toContain("GeoSite");
    expect(html).toContain(">120<");
    expect(html).toContain("GeoIP");
    expect(html).toContain(">30<");
    expect(html).toContain("规则总数");
    expect(html).toContain(">150<");
    expect(html).toContain("上次同步");
    expect(html).toContain("下次同步");
    expect(html).toContain("立即同步");
  });

  it("renders stale and bundled source states", () => {
    expect(renderView({ status: { ...status, source: "stale" } })).toContain("过期缓存");
    expect(
      renderView({ status: { ...status, source: "bundled", fetchedAt: null, expiresAt: null } })
    ).toContain("尚未进行远端同步");
  });

  it("renders an error panel with retry", () => {
    const html = renderView({ status: null, error: "KV unavailable" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("规则库状态暂不可用");
    expect(html).toContain("KV unavailable");
    expect(html).toContain("重试");
  });

  it("keeps the last usable status visible when a later status request fails", () => {
    const html = renderView({ error: "temporary failure" });
    expect(html).toContain("状态更新失败：temporary failure");
    expect(html).toContain("MetaCubeX/meta-rules-dat");
    expect(html).toContain(">150<");
    expect(html).toContain("重试状态");
  });

  it("disables the sync command while refreshing", () => {
    const html = renderView({ refreshing: true });
    expect(html).toContain("同步中");
    expect(html).toContain("disabled");
    expect(html).toContain("animate-spin");
  });

  it("loads status with no-store and validates the response", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchRuleCatalogStatus(fetchImpl)).resolves.toEqual(status);
    expect(fetchImpl).toHaveBeenCalledWith("/api/rules/status", {
      cache: "no-store",
      signal: undefined,
    });

    const invalidFetch = vi.fn(async () => new Response(JSON.stringify({ source: "remote" }))) as unknown as typeof fetch;
    await expect(fetchRuleCatalogStatus(invalidFetch)).rejects.toThrow("规则库状态响应无效");

    for (const invalidStatus of [
      { ...status, sourceUrl: "javascript:alert(1)" },
      { ...status, geositeCount: 1.5, totalRules: 31.5 },
      { ...status, totalRules: 149 },
    ]) {
      const invalidBoundaryFetch = vi.fn(async () =>
        new Response(JSON.stringify(invalidStatus), { status: 200 })
      ) as unknown as typeof fetch;
      await expect(fetchRuleCatalogStatus(invalidBoundaryFetch)).rejects.toThrow(
        "规则库状态响应无效"
      );
    }
  });

  it("posts manual refresh and surfaces API failures", async () => {
    const refreshed = { ...status, refreshStatus: "refreshed" as const };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(refreshed), { status: 200 })) as unknown as typeof fetch;
    await expect(refreshRuleCatalogStatus(fetchImpl)).resolves.toEqual(refreshed);
    expect(fetchImpl).toHaveBeenCalledWith("/api/rules/refresh", { method: "POST" });

    const stale = { ...status, source: "stale" as const, refreshStatus: "stale" as const, error: "使用缓存" };
    const staleFetch = vi.fn(async () =>
      new Response(JSON.stringify(stale), { status: 200 })
    ) as unknown as typeof fetch;
    await expect(refreshRuleCatalogStatus(staleFetch)).resolves.toEqual(stale);

    const failedFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "upstream unavailable" }), { status: 503 })
    ) as unknown as typeof fetch;
    await expect(refreshRuleCatalogStatus(failedFetch)).rejects.toThrow("upstream unavailable");
  });
});
