import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuleIndexUnavailableError } from "@subboost/server-core/rules";

import { getCnRuleCandidateDiscovery, searchRules } from "@local/lib/rule-catalog";
import * as cnCandidatesRoute from "../app/api/rules/cn-candidates/route";
import * as searchRoute from "../app/api/rules/search/route";

vi.mock("@local/lib/rule-catalog", () => ({
  getCnRuleCandidateDiscovery: vi.fn(),
  searchRules: vi.fn(),
}));

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.mocked(searchRules).mockReset();
  vi.mocked(getCnRuleCandidateDiscovery).mockReset();
});

describe("local rule routes", () => {
  it("wraps shared rule search results", async () => {
    vi.mocked(searchRules).mockResolvedValue({
      items: [{ id: "openai", name: "openai", nameZh: "OpenAI" }],
      keyword: "openai",
      type: "all",
      page: 1,
      size: 20,
      totalMatched: 1,
      totalRules: 2,
      source: "remote",
    } as never);

    const response = await searchRoute.GET(new NextRequest("http://local.test/api/rules/search?keyword=openai"));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      source: "remote",
      totalMatched: 1,
    });
    expect(searchRules).toHaveBeenCalledWith({
      keyword: "openai",
      type: "all",
      page: 1,
      size: 20,
      allowStale: true,
    });
  });

  it("fails closed when the shared rule index is unavailable", async () => {
    vi.mocked(searchRules).mockRejectedValue(new RuleIndexUnavailableError());

    const response = await searchRoute.GET(new NextRequest("http://local.test/api/rules/search?keyword=bard"));
    expect(response.status).toBe(503);
    expect(await readJson(response)).toMatchObject({
      source: "unavailable",
      code: "RULE_INDEX_UNAVAILABLE",
      items: [],
    });
  });

  it("wraps shared CN candidate discovery results", async () => {
    vi.mocked(getCnRuleCandidateDiscovery).mockResolvedValue({
      items: [{ id: "google-cn", name: "google-cn", behavior: "domain", path: "geosite/google-cn.mrs" }],
      allItems: [{ id: "all", name: "all", behavior: "domain", path: "geosite/all.mrs" }],
      parents: [],
      fetchedAt: 1,
      expiresAt: 2,
      source: "remote",
    } as never);

    const response = await cnCandidatesRoute.GET(
      new NextRequest("http://local.test/api/rules/cn-candidates?modules=google,unknown,google&excluded=geosite:cn,bad,geoip:cn,geosite:cn&debug=1")
    );
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      source: "remote",
      items: [{ id: "google-cn" }],
      allItems: [{ id: "all" }],
    });
    expect(getCnRuleCandidateDiscovery).toHaveBeenCalledWith({
      moduleIds: ["google"],
      excludedRuleKeys: ["geosite:cn", "geoip:cn"],
    });
  });

  it("uses default CN candidate modules and fails closed when discovery is unavailable", async () => {
    vi.mocked(getCnRuleCandidateDiscovery).mockResolvedValueOnce({
      items: [],
      allItems: [],
      parents: [],
      fetchedAt: 1,
      expiresAt: 2,
      source: "stale",
    } as never);

    let response = await cnCandidatesRoute.GET(new NextRequest("http://local.test/api/rules/cn-candidates"));
    expect(response.status).toBe(200);
    const defaultCall = vi.mocked(getCnRuleCandidateDiscovery).mock.calls.at(-1)?.[0] as { moduleIds: string[] };
    expect(defaultCall.moduleIds.length).toBeGreaterThan(0);

    vi.mocked(getCnRuleCandidateDiscovery).mockRejectedValueOnce(new RuleIndexUnavailableError());
    response = await cnCandidatesRoute.GET(new NextRequest("http://local.test/api/rules/cn-candidates?excluded=geoip:cn"));
    expect(response.status).toBe(503);
    expect(await readJson(response)).toMatchObject({
      source: "unavailable",
      code: "RULE_INDEX_UNAVAILABLE",
      items: [],
    });
  });
});

