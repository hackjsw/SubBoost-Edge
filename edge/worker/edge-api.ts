import { parseSubscription } from "@subboost/core/parser";
import {
  DEFAULT_CLASH_CONVERSION_PROFILE_ID,
  getClashConversionProfile,
  isClashConversionProfileId,
  resolveClashConversionProfileId,
  type ClashConversionProfileId,
} from "@subboost/core/subscription/clash-conversion-profiles";
import {
  normalizeSubscriptionResponseInfo,
  type SubscriptionResponseInfo,
} from "@subboost/core/subscription/subscription-response-info";
import type { ParsedNode } from "@subboost/core/types/node";
import { prepareRefreshCacheResult } from "@subboost/server-core/subscription/refresh-cache-result";
import { refreshNodeSnapshot } from "@subboost/server-core/subscription/refresh-node-snapshot";
import { buildSubscriptionResponseHeaders } from "@subboost/server-core/subscription/response-headers";
import type { SavedSource } from "@subboost/server-core/subscription/saved-sources";
import {
  MAX_IMPORT_BYTES,
  MAX_MANAGED_SUBSCRIPTION_NODES,
  MAX_REMOTE_SOURCES,
  MAX_STORED_SUBSCRIPTION_BYTES,
  MAX_STORED_YAML_BYTES,
  MIN_AUTO_UPDATE_INTERVAL_SECONDS,
} from "./constants";
import { byteLength } from "./encoding";
import { json, methodNotAllowed, readJsonBody } from "./http";
import { fetchRemoteText } from "./remote-fetch";
import { convertClashSubscription } from "./subconverter";
import type { ExecutionContextLike, WorkerEnv } from "./types";

const CONFIG_KEY_PREFIX = "edge-config:";
const TOKEN_PATTERN = /^[a-f0-9]{20}$/;
const SUBSCRIPTION_METADATA_VERSION = 1;

type StoredSubscription = {
  version: 2;
  name: string;
  yaml: string;
  urls: string[];
  nodes: ParsedNode[];
  config: Record<string, unknown>;
  conversionProfileId: ClashConversionProfileId;
  subscriptionInfo: SubscriptionResponseInfo;
  autoUpdateInterval: number | null;
  createdAt: string;
  updatedAt: string;
  lastAttemptedAt?: string;
  lastSuccessAt?: string;
  nextUpdateAt?: string;
  lastError?: string;
};

type SubscriptionScheduleMetadata = {
  version: typeof SUBSCRIPTION_METADATA_VERSION;
  autoUpdate: boolean;
  nextUpdateAt?: string;
};

export type ScheduledUpdateSummary = {
  scanned: number;
  due: number;
  updated: number;
  failed: number;
  skipped: number;
};

type RefreshDetails = {
  refreshableSourceCount: number;
  refreshedSourceCount: number;
  refreshedUrlSourceCount: number;
  refreshedStaticSourceCount: number;
  failedSourceCount: number;
  nodeCount: number;
  attemptedUrlFetch: boolean;
  usedUrlFetch: boolean;
};

type RefreshOutcome = {
  record: StoredSubscription;
  ok: boolean;
  details?: RefreshDetails;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeStoredNodes(value: unknown): ParsedNode[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord) as ParsedNode[];
}

function normalizeAutoUpdateInterval(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < MIN_AUTO_UPDATE_INTERVAL_SECONDS
  ) {
    return undefined;
  }
  return value;
}

function parseStoredSubscription(value: string): { record: StoredSubscription; migrated: boolean } | null {
  const raw = JSON.parse(value) as unknown;
  if (!isRecord(raw) || typeof raw.yaml !== "string" || !raw.yaml.trim()) return null;

  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 100) : "EdgeSub";
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString();
  if (raw.version !== 2) {
    return {
      migrated: true,
      record: {
        version: 2,
        name,
        yaml: raw.yaml,
        urls: [],
        nodes: [],
        config: {},
        conversionProfileId: DEFAULT_CLASH_CONVERSION_PROFILE_ID,
        subscriptionInfo: {},
        autoUpdateInterval: null,
        createdAt,
        updatedAt: createdAt,
      },
    };
  }

  const autoUpdateInterval = normalizeAutoUpdateInterval(raw.autoUpdateInterval);
  if (autoUpdateInterval === undefined) return null;
  const config = isRecord(raw.config) ? raw.config : {};
  const conversionProfileId = resolveClashConversionProfileId(raw.conversionProfileId);
  return {
    migrated: raw.conversionProfileId !== conversionProfileId,
    record: {
      version: 2,
      name,
      yaml: raw.yaml,
      urls: normalizeStringList(raw.urls),
      nodes: normalizeStoredNodes(raw.nodes),
      config,
      conversionProfileId,
      subscriptionInfo: normalizeSubscriptionResponseInfo(raw.subscriptionInfo) ?? {},
      autoUpdateInterval,
      createdAt,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt,
      ...(typeof raw.lastAttemptedAt === "string" ? { lastAttemptedAt: raw.lastAttemptedAt } : {}),
      ...(typeof raw.lastSuccessAt === "string" ? { lastSuccessAt: raw.lastSuccessAt } : {}),
      ...(typeof raw.nextUpdateAt === "string" ? { nextUpdateAt: raw.nextUpdateAt } : {}),
      ...(typeof raw.lastError === "string" ? { lastError: raw.lastError.slice(0, 500) } : {}),
    },
  };
}

function hasRefreshSource(config: Record<string, unknown>, urls: string[]): boolean {
  return urls.length > 0 || (Array.isArray(config.sources) && config.sources.length > 0);
}

function nextUpdateTime(now: Date, intervalSeconds: number): string {
  return new Date(now.getTime() + intervalSeconds * 1000).toISOString();
}

function isUpdateDue(record: StoredSubscription, now: Date): boolean {
  if (!record.autoUpdateInterval) return false;
  const explicitNext = record.nextUpdateAt ? Date.parse(record.nextUpdateAt) : Number.NaN;
  if (Number.isFinite(explicitNext)) return explicitNext <= now.getTime();

  const baseline = Date.parse(record.lastSuccessAt || record.updatedAt || record.createdAt);
  return !Number.isFinite(baseline) || baseline + record.autoUpdateInterval * 1000 <= now.getTime();
}

function subscriptionScheduleMetadata(record: StoredSubscription): SubscriptionScheduleMetadata {
  return {
    version: SUBSCRIPTION_METADATA_VERSION,
    autoUpdate: Boolean(record.autoUpdateInterval),
    ...(record.nextUpdateAt ? { nextUpdateAt: record.nextUpdateAt } : {}),
  };
}

function metadataUpdateDue(metadata: unknown, now: Date): boolean | null {
  if (
    !isRecord(metadata) ||
    metadata.version !== SUBSCRIPTION_METADATA_VERSION ||
    typeof metadata.autoUpdate !== "boolean"
  ) {
    return null;
  }
  if (!metadata.autoUpdate) return false;
  if (typeof metadata.nextUpdateAt !== "string") return true;
  const nextUpdateAt = Date.parse(metadata.nextUpdateAt);
  return !Number.isFinite(nextUpdateAt) || nextUpdateAt <= now.getTime();
}

function refreshFailureMessage(reason: string): string {
  if (reason === "all_sources_failed") return "所有订阅源更新失败";
  if (reason === "empty_result") return "更新后没有可用节点";
  if (reason === "node_quota_exceeded") return "更新后的节点数量超过限制";
  return "订阅更新失败";
}

function buildRefreshCallbacks() {
  let remoteRequests = 0;
  const reserveRemoteRequest = () => {
    remoteRequests += 1;
    if (remoteRequests > MAX_REMOTE_SOURCES) throw new Error("单次更新的远程订阅源过多");
  };

  return {
    fetchUrlNodes: async (source: SavedSource) => {
      try {
        reserveRemoteRequest();
        const fetched = await fetchRemoteText(source.content, {
          maxBytes: MAX_IMPORT_BYTES,
          timeoutMs: 15000,
          userAgent: source.userinfoUserAgent || "EdgeSub/2.6",
        });
        const parsed = parseSubscription(fetched.content);
        return {
          ok: parsed.nodes.length > 0,
          nodes: parsed.nodes,
          errors: parsed.errors,
          headers: fetched.headers,
          responseStatus: fetched.status,
        };
      } catch (error) {
        return {
          ok: false,
          nodes: [],
          error: error instanceof Error ? error.message : "订阅源更新失败",
        };
      }
    },
    fetchUrlUserInfo: async (source: SavedSource) => {
      try {
        reserveRemoteRequest();
        const fetched = await fetchRemoteText(source.userinfoUrl || source.content, {
          maxBytes: 256 * 1024,
          timeoutMs: 8000,
          userAgent: source.userinfoUserAgent || "EdgeSub/2.6",
          method: "HEAD",
        });
        return fetched.headers;
      } catch {
        return undefined;
      }
    },
  };
}

async function refreshStoredSubscription(
  record: StoredSubscription,
  now: Date
): Promise<RefreshOutcome> {
  const attemptedAt = now.toISOString();

  const failureRecord = (message: string): StoredSubscription => {
    const next: StoredSubscription = {
      ...record,
      lastAttemptedAt: attemptedAt,
      lastError: message.slice(0, 500),
    };
    if (record.autoUpdateInterval) {
      next.nextUpdateAt = nextUpdateTime(
        now,
        Math.min(record.autoUpdateInterval, MIN_AUTO_UPDATE_INTERVAL_SECONDS)
      );
    } else {
      delete next.nextUpdateAt;
    }
    return next;
  };

  try {
    const snapshot = await refreshNodeSnapshot({
      config: record.config,
      urls: record.urls,
      storedNodes: record.nodes,
      ...buildRefreshCallbacks(),
    });
    const result = prepareRefreshCacheResult({
      config: record.config,
      snapshot,
      maxNodesPerSubscription: MAX_MANAGED_SUBSCRIPTION_NODES,
    });
    const details: RefreshDetails = {
      refreshableSourceCount: snapshot.refreshableSourceCount,
      refreshedSourceCount: snapshot.refreshedSourceCount,
      refreshedUrlSourceCount: snapshot.refreshedUrlSourceCount,
      refreshedStaticSourceCount: snapshot.refreshedStaticSourceCount,
      failedSourceCount: snapshot.failedSourceCount,
      nodeCount: result.nodeCount,
      attemptedUrlFetch: snapshot.attemptedUrlFetch,
      usedUrlFetch: snapshot.usedUrlFetch,
    };
    if (!result.ok) {
      return {
        ok: false,
        record: failureRecord(refreshFailureMessage(result.reason)),
        details,
      };
    }

    const nextRecord: StoredSubscription = {
      ...record,
      yaml: result.generatedYaml,
      nodes: result.cacheEntry.nodes,
      config: { ...record.config, sources: snapshot.savedSources },
      subscriptionInfo: result.cacheEntry.subscriptionInfo,
      updatedAt: attemptedAt,
      lastAttemptedAt: attemptedAt,
      lastSuccessAt: attemptedAt,
    };
    delete nextRecord.lastError;
    if (record.autoUpdateInterval) {
      nextRecord.nextUpdateAt = nextUpdateTime(now, record.autoUpdateInterval);
    } else {
      delete nextRecord.nextUpdateAt;
    }

    return {
      ok: true,
      record: nextRecord,
      details,
    };
  } catch (error) {
    return {
      ok: false,
      record: failureRecord(error instanceof Error ? error.message : "订阅更新失败"),
    };
  }
}

function errorInfo(message: string, category: "format" | "security" | "network" | "server") {
  return { category, message, detail: message };
}

function classifyImportError(message: string): "format" | "security" | "network" | "server" {
  if (/禁止|不允许|只支持 HTTP/i.test(message)) return "security";
  if (/无效|过大/i.test(message)) return "format";
  if (/HTTP|超时|fetch|network/i.test(message)) return "network";
  return "server";
}

async function listSubscriptionKeys(env: WorkerEnv): Promise<string[]> {
  if (!env.SUB_KV) return [];
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.SUB_KV.list({
      prefix: CONFIG_KEY_PREFIX,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    names.push(...page.keys.map((key) => key.name));
    if (page.list_complete || !page.cursor || page.cursor === cursor) break;
    cursor = page.cursor;
  } while (cursor);
  return names;
}

export async function handleAuthMe(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const subscriptionCount = (await listSubscriptionKeys(env)).length;
  return json({
    user: {
      id: "edge-workspace",
      username: "edge",
      name: "EdgeSub",
      avatarUrl: null,
      trustLevel: 0,
      aiAssistantEnabled: false,
      isAdmin: true,
      isBanned: false,
      active: true,
      silenced: false,
      saveRequirementSatisfied: true,
      saveRequirementSatisfiedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      quota: {
        maxSubscriptions: 9999,
        maxNodesPerSubscription: 10000,
        maxCustomTemplates: 0,
        maxImportSourcesPerType: 100,
        canUseSubscriptionLink: true,
      },
      subscriptionCount,
      templateCount: 0,
    },
  });
}

export function handleHealth(request: Request, env: WorkerEnv): Response {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  return json({
    status: "ok",
    service: "edgesub",
    version: "2.6.0-edge.2",
    kv: Boolean(env.SUB_KV),
    auth: Boolean(env.EDGE_ADMIN_PASSWORD?.trim()),
  });
}

export async function handleSourceImport(request: Request): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const body = await readJsonBody(request);
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!url) {
    const message = "订阅 URL 不能为空";
    return json({ error: message, errorInfo: errorInfo(message, "format") }, 400);
  }

  try {
    const userAgent =
      typeof body?.userinfoUserAgent === "string" && body.userinfoUserAgent.trim()
        ? body.userinfoUserAgent.trim().slice(0, 200)
        : "EdgeSub/2.6";
    const source = await fetchRemoteText(url, {
      maxBytes: MAX_IMPORT_BYTES,
      timeoutMs: 15000,
      userAgent,
    });
    const headers = { ...source.headers };

    if (typeof body?.userinfoUrl === "string" && body.userinfoUrl.trim()) {
      try {
        const userinfo = await fetchRemoteText(body.userinfoUrl.trim(), {
          maxBytes: 256 * 1024,
          timeoutMs: 8000,
          userAgent,
          method: "HEAD",
        });
        const value = userinfo.headers["subscription-userinfo"];
        if (value) headers["subscription-userinfo"] = value;
      } catch {}
    }

    return json({ content: source.content, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "获取 url 失败";
    return json({ error: message, errorInfo: errorInfo(message, classifyImportError(message)) }, 400);
  }
}

function createToken(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

function buildStoredSubscription(
  body: Record<string, unknown>,
  now: Date,
  existing?: StoredSubscription
): { record: StoredSubscription } | { response: Response } {
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "EdgeSub";
  const yaml = typeof body.yaml === "string" ? body.yaml : "";
  if (!yaml.trim()) return { response: json({ error: "请先生成配置" }, 400) };
  if (byteLength(yaml) > MAX_STORED_YAML_BYTES) {
    return { response: json({ error: "配置文件过大" }, 413) };
  }

  const autoUpdateInterval = normalizeAutoUpdateInterval(body.autoUpdateInterval);
  if (autoUpdateInterval === undefined) {
    return {
      response: json({ error: `自动更新间隔不能小于 ${MIN_AUTO_UPDATE_INTERVAL_SECONDS / 3600} 小时` }, 400),
    };
  }
  const urls = normalizeStringList(body.urls);
  const nodes = normalizeStoredNodes(body.nodes);
  const config = isRecord(body.config) ? body.config : {};
  const hasConversionProfile = Object.prototype.hasOwnProperty.call(body, "conversionProfileId");
  if (hasConversionProfile && !isClashConversionProfileId(body.conversionProfileId)) {
    return { response: json({ error: "无效的 Clash 规则方案" }, 400) };
  }
  const conversionProfileId = hasConversionProfile
    ? (body.conversionProfileId as ClashConversionProfileId)
    : existing?.conversionProfileId ?? DEFAULT_CLASH_CONVERSION_PROFILE_ID;
  if (autoUpdateInterval && !hasRefreshSource(config, urls)) {
    return { response: json({ error: "自动更新需要至少一个可保存的订阅源" }, 400) };
  }

  const createdAt = now.toISOString();
  const record: StoredSubscription = {
    version: 2,
    name,
    yaml,
    urls,
    nodes,
    config,
    conversionProfileId,
    subscriptionInfo: normalizeSubscriptionResponseInfo(body.subscriptionInfo) ?? {},
    autoUpdateInterval,
    createdAt: existing?.createdAt || createdAt,
    updatedAt: createdAt,
    ...(autoUpdateInterval ? { nextUpdateAt: nextUpdateTime(now, autoUpdateInterval) } : {}),
  };
  const stored = JSON.stringify(record);
  if (byteLength(stored) > MAX_STORED_SUBSCRIPTION_BYTES) {
    return { response: json({ error: "订阅数据过大，无法保存到 KV" }, 413) };
  }
  return { record };
}

function publicSubscription(token: string, record: StoredSubscription, origin: string) {
  return {
    id: token,
    token,
    name: record.name,
    subscriptionUrl: `${origin}/config/${token}`,
    isPrimary: false,
    autoUpdateInterval: record.autoUpdateInterval,
    conversionProfileId: record.conversionProfileId,
    autoUpdateState: {
      externalFailureCount: record.lastError ? 1 : 0,
      failureSourceState: record.lastError ?? null,
      lastFailedAt: record.lastError ? record.lastAttemptedAt ?? null : null,
      lastAttemptedAt: record.lastAttemptedAt ?? null,
      disabledAt: null,
      disabledReason: null,
      disabledPreviousInterval: null,
    },
    smartNodeMatchingEnabled: record.config.smartNodeMatchingEnabled !== false,
    lastUpdatedAt: record.lastSuccessAt || record.updatedAt,
    lastAccessedAt: null,
    createdAt: record.createdAt,
    persistent: true,
    nextUpdateAt: record.nextUpdateAt ?? null,
  };
}

async function loadStoredSubscription(
  env: WorkerEnv,
  token: string
): Promise<{ record: StoredSubscription; migrated: boolean } | null> {
  if (!env.SUB_KV || !TOKEN_PATTERN.test(token)) return null;
  const stored = await env.SUB_KV.get(`${CONFIG_KEY_PREFIX}${token}`);
  return stored ? parseStoredSubscription(stored) : null;
}

async function persistStoredSubscription(env: WorkerEnv, token: string, record: StoredSubscription): Promise<Response | null> {
  if (!env.SUB_KV) return json({ error: "KV未绑定" }, 503);
  const stored = JSON.stringify(record);
  if (byteLength(stored) > MAX_STORED_SUBSCRIPTION_BYTES) {
    return json({ error: "订阅数据过大，无法保存到 KV" }, 413);
  }
  await env.SUB_KV.put(`${CONFIG_KEY_PREFIX}${token}`, stored, {
    metadata: subscriptionScheduleMetadata(record),
  });
  return null;
}

export async function handleSubscriptions(request: Request, env: WorkerEnv): Promise<Response> {
  if (!env.SUB_KV) return json({ error: "KV未绑定" }, 503);
  const origin = new URL(request.url).origin;

  if (request.method === "GET") {
    const subscriptions: Array<ReturnType<typeof publicSubscription>> = [];
    for (const key of await listSubscriptionKeys(env)) {
      const token = key.slice(CONFIG_KEY_PREFIX.length);
      try {
        const parsed = await loadStoredSubscription(env, token);
        if (parsed) subscriptions.push(publicSubscription(token, parsed.record, origin));
      } catch {}
    }
    subscriptions.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    return json({ subscriptions });
  }

  if (request.method !== "POST") return methodNotAllowed(["GET", "POST"]);
  const body = await readJsonBody(request);
  if (!body) return json({ error: "无效的 JSON 请求" }, 400);
  const built = buildStoredSubscription(body, new Date());
  if ("response" in built) return built.response;

  const token = createToken();
  const persistenceError = await persistStoredSubscription(env, token, built.record);
  if (persistenceError) return persistenceError;

  return json({
    subscription: publicSubscription(token, built.record, origin),
  });
}

export async function handleSubscriptionRecord(request: Request, env: WorkerEnv): Promise<Response> {
  if (!env.SUB_KV) return json({ error: "KV未绑定" }, 503);
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const token = parts[2] || "";
  const action = parts[3] || "";
  if (!TOKEN_PATTERN.test(token)) return json({ error: "订阅不存在" }, 404);

  const parsed = await loadStoredSubscription(env, token);
  if (!parsed) return json({ error: "订阅不存在" }, 404);
  const record = parsed.record;
  if (parsed.migrated) {
    const persistenceError = await persistStoredSubscription(env, token, record);
    if (persistenceError) return persistenceError;
  }

  if (action) {
    if (action !== "refresh") return json({ error: "订阅操作不存在" }, 404);
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    if (!hasRefreshSource(record.config, record.urls)) {
      return json({ error: "该记录没有可重新抓取的订阅源，请在首页重新保存一次" }, 400);
    }

    const refreshed = await refreshStoredSubscription(record, new Date());
    const persistenceError = await persistStoredSubscription(env, token, refreshed.record);
    if (persistenceError) return persistenceError;
    if (!refreshed.ok) {
      return json(
        { error: refreshed.record.lastError || "刷新失败", ...(refreshed.details ?? {}) },
        400
      );
    }
    return json(refreshed.details ?? {});
  }

  if (request.method === "GET") {
    return json({
      subscription: {
        ...publicSubscription(token, record, url.origin),
        urls: record.urls,
        nodes: record.nodes,
        config: record.config,
        subscriptionInfo: record.subscriptionInfo,
      },
    });
  }

  if (request.method === "PUT") {
    const body = await readJsonBody(request);
    if (!body) return json({ error: "无效的 JSON 请求" }, 400);
    const built = buildStoredSubscription(body, new Date(), record);
    if ("response" in built) return built.response;
    const persistenceError = await persistStoredSubscription(env, token, built.record);
    if (persistenceError) return persistenceError;
    return json({ subscription: publicSubscription(token, built.record, url.origin) });
  }

  if (request.method === "PATCH") {
    const body = await readJsonBody(request);
    if (!body) return json({ error: "无效的 JSON 请求" }, 400);
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : record.name;
    if (!name) return json({ error: "订阅名称不能为空" }, 400);
    const autoUpdateInterval = normalizeAutoUpdateInterval(body.autoUpdateInterval);
    if (autoUpdateInterval === undefined) {
      return json({ error: `自动更新间隔不能小于 ${MIN_AUTO_UPDATE_INTERVAL_SECONDS / 3600} 小时` }, 400);
    }
    if (autoUpdateInterval && !hasRefreshSource(record.config, record.urls)) {
      return json({ error: "该记录没有可自动更新的订阅源" }, 400);
    }

    const next: StoredSubscription = {
      ...record,
      name,
      autoUpdateInterval,
      config: {
        ...record.config,
        smartNodeMatchingEnabled:
          typeof body.smartNodeMatchingEnabled === "boolean"
            ? body.smartNodeMatchingEnabled
            : record.config.smartNodeMatchingEnabled !== false,
      },
    };
    delete next.lastError;
    if (autoUpdateInterval) next.nextUpdateAt = nextUpdateTime(new Date(), autoUpdateInterval);
    else delete next.nextUpdateAt;

    const persistenceError = await persistStoredSubscription(env, token, next);
    if (persistenceError) return persistenceError;
    return json({ subscription: publicSubscription(token, next, url.origin) });
  }

  if (request.method === "DELETE") {
    await env.SUB_KV.delete(`${CONFIG_KEY_PREFIX}${token}`);
    return new Response(null, { status: 204 });
  }

  return methodNotAllowed(["GET", "PUT", "PATCH", "DELETE"]);
}

export async function handleStoredConfig(
  request: Request,
  env: WorkerEnv,
  ctx?: ExecutionContextLike
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(["GET", "HEAD"]);
  if (!env.SUB_KV) return new Response("KV is not configured", { status: 503 });
  const requestUrl = new URL(request.url);
  const token = requestUrl.pathname.split("/").filter(Boolean).at(-1) || "";
  if (!TOKEN_PATTERN.test(token)) return new Response("Subscription not found", { status: 404 });

  const key = `${CONFIG_KEY_PREFIX}${token}`;
  const stored = await env.SUB_KV.get(key);
  if (!stored) return new Response("Subscription not found", { status: 404 });

  try {
    const parsed = parseStoredSubscription(stored);
    if (!parsed) throw new Error("invalid config");
    const { record } = parsed;
    if (parsed.migrated) {
      const migration = env.SUB_KV.put(key, JSON.stringify(record), {
        metadata: subscriptionScheduleMetadata(record),
      });
      if (ctx) ctx.waitUntil(migration);
      else await migration;
    }

    const headers = new Headers(
      buildSubscriptionResponseHeaders(record.name, record.subscriptionInfo, {
        autoUpdateIntervalSeconds: record.autoUpdateInterval,
        isAdmin: true,
        cacheControl: "no-store",
      })
    );
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-SubBoost-Storage", "persistent-kv");
    headers.set("X-SubBoost-Auto-Update", record.autoUpdateInterval ? "enabled" : "disabled");
    headers.set("X-SubBoost-Last-Updated", record.updatedAt);
    if (record.nextUpdateAt) headers.set("X-SubBoost-Next-Update", record.nextUpdateAt);

    if (requestUrl.searchParams.get("raw") !== "1") {
      const profile = getClashConversionProfile(record.conversionProfileId);
      if (profile.configUrl) {
        const sourceUrl = new URL(request.url);
        sourceUrl.searchParams.set("raw", "1");
        return convertClashSubscription({
          env,
          sourceUrl: sourceUrl.toString(),
          configUrl: profile.configUrl,
          method: request.method,
          responseHeaders: headers,
        });
      }
    }

    return new Response(request.method === "HEAD" ? null : record.yaml, {
      headers,
    });
  } catch {
    return new Response("Stored subscription is invalid", { status: 500 });
  }
}

export async function runScheduledSubscriptionUpdates(
  env: WorkerEnv,
  now = new Date()
): Promise<ScheduledUpdateSummary> {
  if (!env.SUB_KV) throw new Error("KV is not configured");
  const summary: ScheduledUpdateSummary = { scanned: 0, due: 0, updated: 0, failed: 0, skipped: 0 };
  let cursor: string | undefined;

  do {
    const page = await env.SUB_KV.list({
      prefix: CONFIG_KEY_PREFIX,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });

    for (const key of page.keys) {
      summary.scanned += 1;
      const dueFromMetadata = metadataUpdateDue(key.metadata, now);
      if (dueFromMetadata === false) {
        summary.skipped += 1;
        continue;
      }

      try {
        const stored = await env.SUB_KV.get(key.name);
        const parsed = stored ? parseStoredSubscription(stored) : null;
        if (!parsed) {
          summary.skipped += 1;
          continue;
        }

        if (parsed.migrated || !isUpdateDue(parsed.record, now)) {
          await env.SUB_KV.put(key.name, JSON.stringify(parsed.record), {
            metadata: subscriptionScheduleMetadata(parsed.record),
          });
          summary.skipped += 1;
          continue;
        }

        summary.due += 1;
        const refreshed = await refreshStoredSubscription(parsed.record, now);
        await env.SUB_KV.put(key.name, JSON.stringify(refreshed.record), {
          metadata: subscriptionScheduleMetadata(refreshed.record),
        });
        if (refreshed.ok) summary.updated += 1;
        else summary.failed += 1;
      } catch {
        summary.failed += 1;
      }
    }

    if (page.list_complete || !page.cursor || page.cursor === cursor) break;
    cursor = page.cursor;
  } while (cursor);

  return summary;
}
