import { PROXY_GROUP_MODULES } from "@subboost/core/generator/proxy-group-modules";
import { ALL_RULES } from "@subboost/core/rules-database";
import {
  buildCnRuleCandidateResponse,
  buildCnRuleCandidateUnavailableResponse,
  createRuleCatalogService,
  normalizeRuleSearchType,
  parseCnRuleCandidateQuery,
  RuleIndexUnavailableError,
  type RemoteRuleIndex,
  type RuleIndexRefreshResult,
} from "@subboost/server-core/rules";
import type {
  RuleCatalogRefreshResponse,
  RuleCatalogStatusResponse,
  RuleCatalogStatusSource,
} from "../src/lib/rule-catalog-status";
import { json, methodNotAllowed } from "./http";
import type { KVNamespaceLike, WorkerEnv } from "./types";

export const RULE_INDEX_CACHE_KEY = "edge-rule-index:v1";
export const RULE_CATALOG_CRON = "17 3 * * *";
const RULE_CATALOG_SOURCE_LABEL = "MetaCubeX/meta-rules-dat";
const RULE_CATALOG_SOURCE_URL = "https://github.com/MetaCubeX/meta-rules-dat";
const RULE_CATALOG_REFRESH_FAILED_MESSAGE = "远端规则目录同步失败，请稍后重试";
const RULE_CATALOG_REFRESH_STALE_MESSAGE = "远端同步失败，当前继续使用缓存";
const MAX_RULE_SEARCH_PAGE_SIZE = 100;

type RuleCatalogService = ReturnType<typeof createRuleCatalogService>;

let activeKv: KVNamespaceLike | undefined;
let activeService: RuleCatalogService | undefined;
let activeGitHubToken: string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseCachedRuleIndex(value: string): RemoteRuleIndex | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !isRecord(parsed) ||
      !Array.isArray(parsed.geosite) ||
      !parsed.geosite.every((item) => typeof item === "string") ||
      !Array.isArray(parsed.geoip) ||
      !parsed.geoip.every((item) => typeof item === "string") ||
      typeof parsed.fetchedAt !== "number" ||
      !Number.isFinite(parsed.fetchedAt) ||
      typeof parsed.expiresAt !== "number" ||
      !Number.isFinite(parsed.expiresAt)
    ) {
      return null;
    }

    return {
      geosite: parsed.geosite,
      geoip: parsed.geoip,
      fetchedAt: parsed.fetchedAt,
      expiresAt: parsed.expiresAt,
      source: parsed.source === "stale" ? "stale" : "remote",
    };
  } catch {
    return null;
  }
}

function bundledRuleIndex(now = Date.now()): RemoteRuleIndex {
  const geosite = new Set<string>();
  const geoip = new Set<string>();
  const addPath = (value: string) => {
    const match = value.match(/(?:^|\/)(geosite|geoip)\/([^/?#]+)\.mrs(?:[?#].*)?$/i);
    if (!match) return;
    const target = match[1].toLowerCase() === "geoip" ? geoip : geosite;
    target.add(match[2]);
  };

  ALL_RULES.forEach((rule) => addPath(rule.url));
  PROXY_GROUP_MODULES.forEach((module) => module.rules.forEach((rule) => addPath(rule.path)));

  return {
    geosite: Array.from(geosite).sort((left, right) => left.localeCompare(right)),
    geoip: Array.from(geoip).sort((left, right) => left.localeCompare(right)),
    fetchedAt: now,
    expiresAt: 0,
    source: "stale",
  };
}

export function getNextRuleCatalogRunAt(now = Date.now()): number {
  const next = new Date(now);
  next.setUTCHours(3, 17, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime();
}

function buildRuleCatalogStatus(
  index: RemoteRuleIndex,
  source: RuleCatalogStatusSource,
  now = Date.now()
): RuleCatalogStatusResponse {
  const hasRemoteSnapshot = source !== "bundled";
  return {
    source,
    sourceLabel: RULE_CATALOG_SOURCE_LABEL,
    sourceUrl: RULE_CATALOG_SOURCE_URL,
    geositeCount: index.geosite.length,
    geoipCount: index.geoip.length,
    totalRules: index.geosite.length + index.geoip.length,
    fetchedAt: hasRemoteSnapshot ? index.fetchedAt : null,
    expiresAt: hasRemoteSnapshot ? index.expiresAt : null,
    schedule: RULE_CATALOG_CRON,
    nextScheduledAt: getNextRuleCatalogRunAt(now),
  };
}

function storedRuleCatalogSource(index: RemoteRuleIndex, now: number): RuleCatalogStatusSource {
  return index.source === "remote" && index.expiresAt > now ? "remote" : "stale";
}

async function readRuleCatalogStatus(env: WorkerEnv, now = Date.now()): Promise<RuleCatalogStatusResponse> {
  const stored = await env.SUB_KV!.get(RULE_INDEX_CACHE_KEY);
  const index = stored ? parseCachedRuleIndex(stored) : null;
  if (!index) return buildRuleCatalogStatus(bundledRuleIndex(now), "bundled", now);
  return buildRuleCatalogStatus(index, storedRuleCatalogSource(index, now), now);
}

function getRuleCatalogService(env: WorkerEnv): RuleCatalogService | null {
  const kv = env.SUB_KV;
  if (!kv) return null;
  const githubToken = env.GITHUB_TOKEN?.trim() || undefined;
  if (activeKv === kv && activeGitHubToken === githubToken && activeService) return activeService;

  activeKv = kv;
  activeGitHubToken = githubToken;
  activeService = createRuleCatalogService({
    userAgent: "EdgeSub/2.6",
    getGitHubToken: () => githubToken,
    indexCache: {
      read: async () => {
        const stored = await kv.get(RULE_INDEX_CACHE_KEY);
        return stored ? parseCachedRuleIndex(stored) ?? bundledRuleIndex() : bundledRuleIndex();
      },
      write: (index) => kv.put(RULE_INDEX_CACHE_KEY, JSON.stringify(index)),
    },
    logger: console,
  });
  return activeService;
}

function positiveInteger(value: string | null, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

export async function handleRulesSearch(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const service = getRuleCatalogService(env);
  if (!service) return json({ error: "KV未绑定" }, 503);

  const url = new URL(request.url);
  const keyword = url.searchParams.get("keyword") || "";
  const page = positiveInteger(url.searchParams.get("page"), 1);
  const size = positiveInteger(url.searchParams.get("size"), 20, MAX_RULE_SEARCH_PAGE_SIZE);

  try {
    return json(
      await service.searchRules({
        keyword,
        type: normalizeRuleSearchType(url.searchParams.get("type")),
        page,
        size,
        allowStale: true,
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "规则库暂不可用";
    const status = error instanceof RuleIndexUnavailableError ? 503 : 500;
    return json({ error: message, items: [], totalRules: 0, totalMatched: 0, source: "unavailable" }, status);
  }
}

export async function handleRulesStatus(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  if (!env.SUB_KV) return json({ error: "KV未绑定" }, 503);

  try {
    return json(await readRuleCatalogStatus(env));
  } catch {
    return json({ error: "规则库状态暂不可用" }, 503);
  }
}

export async function handleRulesRefresh(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const service = getRuleCatalogService(env);
  if (!service) {
    return json({ error: "KV未绑定" }, 503);
  }

  try {
    const result = await service.refreshRuleIndex({ force: true });
    if (result.status === "unavailable") {
      return json({ error: RULE_CATALOG_REFRESH_FAILED_MESSAGE }, 503);
    }

    const now = Date.now();
    const response: RuleCatalogRefreshResponse = {
      ...buildRuleCatalogStatus(result.index, storedRuleCatalogSource(result.index, now), now),
      refreshStatus: result.status,
      ...(result.status === "stale" ? { error: RULE_CATALOG_REFRESH_STALE_MESSAGE } : {}),
    };
    return json(response);
  } catch {
    return json({ error: RULE_CATALOG_REFRESH_FAILED_MESSAGE }, 503);
  }
}

export async function handleCnRuleCandidates(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const service = getRuleCatalogService(env);
  if (!service) return json({ error: "KV未绑定" }, 503);

  const query = parseCnRuleCandidateQuery(new URL(request.url).searchParams);
  try {
    const result = await service.getCnRuleCandidateDiscovery({
      moduleIds: query.moduleIds,
      excludedRuleKeys: query.excludedRuleKeys,
    });
    return json(buildCnRuleCandidateResponse(result, { debug: query.debug }));
  } catch {
    return json(buildCnRuleCandidateUnavailableResponse(), 503);
  }
}

export async function runScheduledRuleCatalogUpdate(env: WorkerEnv): Promise<RuleIndexRefreshResult> {
  const service = getRuleCatalogService(env);
  if (!service) throw new Error("KV is not configured");
  return service.refreshRuleIndex({ force: true });
}
