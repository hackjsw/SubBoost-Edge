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
import { validateCronSecret } from "@subboost/server-core/cron-auth";
import { prepareRefreshCacheResult } from "@subboost/server-core/subscription/refresh-cache-result";
import { refreshNodeSnapshot } from "@subboost/server-core/subscription/refresh-node-snapshot";
import { buildSubscriptionResponseHeaders } from "@subboost/server-core/subscription/response-headers";
import type { SavedSource } from "@subboost/server-core/subscription/saved-sources";
import {
  buildSourceImportParseResult,
  importSubscriptionFromUrl,
  type SourceImportTransportRequest,
  type SourceImportTransportResult,
} from "@subboost/server-core/subscription/source-import";
import { SUBSCRIPTION_IMPORT_USER_AGENTS } from "@subboost/server-core/subscription/user-agents";
import {
  MAX_IMPORT_BYTES,
  MAX_MANAGED_SUBSCRIPTION_NODES,
  MAX_REMOTE_REQUESTS_PER_REFRESH,
  MAX_REMOTE_SOURCES,
  MAX_STORED_SUBSCRIPTION_BYTES,
  MAX_STORED_YAML_BYTES,
  MIN_AUTO_UPDATE_INTERVAL_SECONDS,
} from "./constants";
import { byteLength } from "./encoding";
import { isAuthenticated } from "./auth";
import { json, methodNotAllowed, readJsonBody } from "./http";
import { fetchRemoteText } from "./remote-fetch";
import { createStoredConfigCapability } from "./stored-config-capability";
import {
  invalidateStoredConfigCache,
  loadStoredConfigResponse,
  storedConfigCacheKey,
} from "./stored-config-cache";
import { convertClashSubscription } from "./subconverter";
import type { ExecutionContextLike, WorkerEnv } from "./types";

const CONFIG_KEY_PREFIX = "edge-config:";
const TOKEN_PATTERN = /^[a-f0-9]{20}$/;
const SUBSCRIPTION_METADATA_VERSION = 1;

// KV has no compare-and-set primitive. Serialize mutations per token in this
// Worker instance and re-check the value before migrations/cron writes; a
// separate isolate can still win the race, so callers must handle a mismatch.
const storedMutationQueues = new Map<string, Promise<void>>();

function enqueueStoredMutation(token: string, operation: () => Promise<void>): Promise<void> {
  const previous = storedMutationQueues.get(token) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const tracked = run.then(
    () => undefined,
    () => undefined
  );
  storedMutationQueues.set(token, tracked);
  return run.finally(() => {
    if (storedMutationQueues.get(token) === tracked) storedMutationQueues.delete(token);
  });
}

function storedConfigError(message: string, status: number, method: "GET" | "HEAD"): Response {
  return new Response(method === "HEAD" ? null : message, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain;charset=UTF-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

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

async function putStoredSubscriptionIfUnchanged(
  env: WorkerEnv,
  token: string,
  key: string,
  expected: string,
  record: StoredSubscription
): Promise<boolean> {
  const kv = env.SUB_KV;
  if (!kv) return false;
  let wrote = false;
  // Invalidate before entering the per-token queue so a pending mutation
  // cannot leave an already-cached response authoritative while it waits.
  invalidateStoredConfigCache(token);
  await enqueueStoredMutation(token, async () => {
    const current = await kv.get(key);
    if (current !== expected) return;
    invalidateStoredConfigCache(token);
    await kv.put(key, JSON.stringify(record), {
      metadata: subscriptionScheduleMetadata(record),
    });
    invalidateStoredConfigCache(token);
    wrote = true;
  });
  return wrote;
}

async function migrateStoredSubscriptionIfUnchanged(
  env: WorkerEnv,
  token: string,
  key: string,
  expected: string,
  record: StoredSubscription
): Promise<boolean> {
  try {
    return await putStoredSubscriptionIfUnchanged(env, token, key, expected, record);
  } catch {
    // Migration is an optimization; serving the already parsed record remains
    // safe when the best-effort backfill cannot be persisted.
    return false;
  }
}

async function deleteStoredSubscriptionIfUnchanged(
  env: WorkerEnv,
  token: string,
  key: string,
  expected: string
): Promise<boolean> {
  const kv = env.SUB_KV;
  if (!kv) return false;
  let deleted = false;
  invalidateStoredConfigCache(token);
  await enqueueStoredMutation(token, async () => {
    const current = await kv.get(key);
    if (current !== expected) return;
    invalidateStoredConfigCache(token);
    await kv.delete(key);
    invalidateStoredConfigCache(token);
    deleted = true;
  });
  return deleted;
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

async function fetchSourceImportTransport(
  request: SourceImportTransportRequest
): Promise<SourceImportTransportResult> {
  try {
    const fetched = await fetchRemoteText(request.url, {
      maxBytes: request.maxBytes,
      timeoutMs: request.timeoutMs,
      userAgent: request.userAgent,
      method: request.purpose === "userinfo" ? "HEAD" : "GET",
      signal: request.signal,
    });
    return {
      ok: true,
      content: request.purpose === "userinfo" ? "" : fetched.content,
      headers: fetched.headers,
      responseStatus: fetched.status,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "获取 url 失败";
    const statusMatch = message.match(/\bHTTP (\d{3})\b/);
    const status = statusMatch ? Number(statusMatch[1]) : undefined;
    return {
      ok: false,
      error: message,
      responseStatus: status,
      publicReason: status ? `HTTP ${status}` : message,
    };
  }
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
    if (remoteRequests > MAX_REMOTE_REQUESTS_PER_REFRESH) {
      throw new Error("单次更新的远程请求次数过多");
    }
  };

  return {
    fetchUrlNodes: async (source: SavedSource) => {
      try {
        const imported = await importSubscriptionFromUrl(
          {
            url: source.content,
            ...(source.userinfoUrl ? { userinfoUrl: source.userinfoUrl } : {}),
            ...(source.userinfoUserAgent ? { userinfoUserAgent: source.userinfoUserAgent } : {}),
          },
          {
            timeoutMs: 15000,
            maxBytes: MAX_IMPORT_BYTES,
            fetchText: (request) => {
              reserveRemoteRequest();
              return fetchSourceImportTransport(request);
            },
          }
        );
        if (imported.ok) {
          return {
            ok: true,
            nodes: imported.parsedNodes,
            errors: imported.parseErrors,
            headers: imported.headers,
            userinfoFetchAttempted: Boolean(source.userinfoUrl || source.userinfoUserAgent),
          };
        }
        return {
          ok: false,
          nodes: [],
          userinfoFetchAttempted: Boolean(source.userinfoUrl || source.userinfoUserAgent),
          error: imported.error,
          errorInfo: imported.errorInfo,
          publicReason: imported.publicReason ?? undefined,
          responseStatus: imported.responseStatus,
        };
      } catch (error) {
        return {
          ok: false,
          nodes: [],
          userinfoFetchAttempted: Boolean(source.userinfoUrl || source.userinfoUserAgent),
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
          userAgent: source.userinfoUserAgent || SUBSCRIPTION_IMPORT_USER_AGENTS[0],
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

function errorInfo(message: string, category: "format" | "security" | "network" | "server" | "parse") {
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

export async function handleCronSubscriptionUpdates(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const cronAuth = validateCronSecret({
    cronSecret: env.CRON_SECRET,
    authorization: request.headers.get("authorization"),
  });
  if (!cronAuth.ok && !(await isAuthenticated(request, env))) {
    if (cronAuth.reason === "missing-secret") {
      return json({ error: "未配置 CRON_SECRET" }, 503);
    }
    return json({ error: "未授权" }, 401);
  }
  if (!env.SUB_KV) return json({ error: "KV未绑定" }, 503);
  const summary = await runScheduledSubscriptionUpdates(env);
  return json({
    success: true,
    ...summary,
    timestamp: new Date().toISOString(),
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
    const imported = await importSubscriptionFromUrl(
      {
        url,
        ...(typeof body?.userinfoUrl === "string" && body.userinfoUrl.trim()
          ? { userinfoUrl: body.userinfoUrl.trim() }
          : {}),
        ...(typeof body?.userinfoUserAgent === "string" && body.userinfoUserAgent.trim()
          ? { userinfoUserAgent: body.userinfoUserAgent.trim().slice(0, 200) }
          : {}),
      },
      {
        timeoutMs: 15000,
        maxBytes: MAX_IMPORT_BYTES,
        fetchText: fetchSourceImportTransport,
      }
    );
    if (!imported.ok) {
      return json({
        error: imported.error,
        errorInfo: imported.errorInfo ?? errorInfo(imported.error, "parse"),
      }, 400);
    }

    return json({
      content: imported.content,
      headers: imported.headers,
      parseResult: buildSourceImportParseResult(imported),
    });
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
): Promise<{ record: StoredSubscription; migrated: boolean; stored: string } | null> {
  if (!env.SUB_KV || !TOKEN_PATTERN.test(token)) return null;
  let stored: string | null;
  try {
    stored = await env.SUB_KV.get(`${CONFIG_KEY_PREFIX}${token}`);
  } catch {
    return null;
  }
  if (!stored) return null;
  let parsed: { record: StoredSubscription; migrated: boolean } | null;
  try {
    parsed = parseStoredSubscription(stored);
  } catch {
    return null;
  }
  return parsed ? { ...parsed, stored } : null;
}

async function persistStoredSubscription(
  env: WorkerEnv,
  token: string,
  record: StoredSubscription,
  expectedStored?: string
): Promise<Response | null> {
  if (!env.SUB_KV) return json({ error: "KV未绑定" }, 503);
  const stored = JSON.stringify(record);
  if (byteLength(stored) > MAX_STORED_SUBSCRIPTION_BYTES) {
    return json({ error: "订阅数据过大，无法保存到 KV" }, 413);
  }
  if (expectedStored !== undefined) {
    const persisted = await putStoredSubscriptionIfUnchanged(
      env,
      token,
      `${CONFIG_KEY_PREFIX}${token}`,
      expectedStored,
      record
    );
    return persisted ? null : json({ error: "订阅已被其他请求更新，请重试" }, 409);
  }
  invalidateStoredConfigCache(token);
  await enqueueStoredMutation(token, async () => {
    await env.SUB_KV!.put(`${CONFIG_KEY_PREFIX}${token}`, stored, {
      metadata: subscriptionScheduleMetadata(record),
    });
    invalidateStoredConfigCache(token);
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
  let expectedStored = parsed.stored;
  if (parsed.migrated) {
    const migrated = await migrateStoredSubscriptionIfUnchanged(
      env,
      token,
      `${CONFIG_KEY_PREFIX}${token}`,
      parsed.stored,
      record
    );
    if (migrated) expectedStored = JSON.stringify(record);
  }

  if (action) {
    if (action !== "refresh") return json({ error: "订阅操作不存在" }, 404);
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    if (!hasRefreshSource(record.config, record.urls)) {
      return json({ error: "该记录没有可重新抓取的订阅源，请在首页重新保存一次" }, 400);
    }

    const refreshed = await refreshStoredSubscription(record, new Date());
    const persistenceError = await persistStoredSubscription(env, token, refreshed.record, expectedStored);
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
    const persistenceError = await persistStoredSubscription(env, token, built.record, expectedStored);
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

    const persistenceError = await persistStoredSubscription(env, token, next, expectedStored);
    if (persistenceError) return persistenceError;
    return json({ subscription: publicSubscription(token, next, url.origin) });
  }

  if (request.method === "DELETE") {
    const deleted = await deleteStoredSubscriptionIfUnchanged(
      env,
      token,
      `${CONFIG_KEY_PREFIX}${token}`,
      expectedStored
    );
    if (!deleted) return json({ error: "订阅已被其他请求更新，请重试" }, 409);
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
  const method: "GET" | "HEAD" = request.method === "HEAD" ? "HEAD" : "GET";
  if (!env.SUB_KV) return storedConfigError("KV is not configured", 503, method);
  const requestUrl = new URL(request.url);
  const token = requestUrl.pathname.split("/").filter(Boolean).at(-1) || "";
  if (!TOKEN_PATTERN.test(token)) return storedConfigError("Subscription not found", 404, method);

  const raw = requestUrl.searchParams.get("raw") === "1";
  return loadStoredConfigResponse(
    storedConfigCacheKey(token, method, raw),
    { method },
    () => loadStoredConfigFromKv(request, env, token, method, raw, ctx)
  );
}

async function loadStoredConfigFromKv(
  request: Request,
  env: WorkerEnv,
  token: string,
  method: "GET" | "HEAD",
  raw: boolean,
  ctx?: ExecutionContextLike
): Promise<Response> {
  const kv = env.SUB_KV;
  if (!kv) return storedConfigError("KV is not configured", 503, method);
  const key = `${CONFIG_KEY_PREFIX}${token}`;
  let stored: string | null;
  try {
    stored = await kv.get(key);
  } catch {
    return storedConfigError("Stored subscription is unavailable", 503, method);
  }
  if (!stored) return storedConfigError("Subscription not found", 404, method);

  try {
    const parsed = parseStoredSubscription(stored);
    if (!parsed) throw new Error("invalid config");
    const { record } = parsed;
    if (parsed.migrated) {
      const migration = migrateStoredSubscriptionIfUnchanged(env, token, key, stored, record);
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

    if (!raw) {
      const profile = getClashConversionProfile(record.conversionProfileId);
      if (profile.configUrl) {
        // A stored config URL is persistent bearer access; only forward its
        // short-lived capability to an explicitly configured converter.
        if (!env.SUBCONVERTER_BACKEND?.trim()) {
          return storedConfigError("Subconverter backend is not configured", 503, method);
        }
        const sourceUrl = await createStoredConfigCapability(env, request.url, record.yaml);
        return convertClashSubscription({
          env,
          sourceUrl,
          configUrl: profile.configUrl,
          method,
          requireExplicitBackend: true,
          responseHeaders: headers,
        });
      }
    }

    headers.set("Content-Length", String(byteLength(record.yaml)));
    return new Response(method === "HEAD" ? null : record.yaml, { headers });
  } catch {
    return storedConfigError("Stored subscription is invalid", 500, method);
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
      const token = key.name.slice(CONFIG_KEY_PREFIX.length);
      const dueFromMetadata = metadataUpdateDue(key.metadata, now);
      if (dueFromMetadata === false) {
        summary.skipped += 1;
        continue;
      }

      try {
        const stored = await env.SUB_KV.get(key.name);
        if (!stored) {
          summary.skipped += 1;
          continue;
        }
        const parsed = parseStoredSubscription(stored);
        if (!parsed) {
          summary.skipped += 1;
          continue;
        }

        let expectedStored = stored;
        if (parsed.migrated) {
          const migrated = await putStoredSubscriptionIfUnchanged(
            env,
            token,
            key.name,
            expectedStored,
            parsed.record
          );
          if (!migrated) {
            summary.skipped += 1;
            continue;
          }
          expectedStored = JSON.stringify(parsed.record);
        }

        if (!isUpdateDue(parsed.record, now)) {
          if (!parsed.migrated) {
            const metadataWritten = await putStoredSubscriptionIfUnchanged(
              env,
              token,
              key.name,
              expectedStored,
              parsed.record
            );
            if (!metadataWritten) {
              summary.skipped += 1;
              continue;
            }
          }
          summary.skipped += 1;
          continue;
        }

        summary.due += 1;
        const refreshed = await refreshStoredSubscription(parsed.record, now);
        const persisted = await putStoredSubscriptionIfUnchanged(
          env,
          token,
          key.name,
          expectedStored,
          refreshed.record
        );
        if (!persisted) {
          summary.skipped += 1;
          continue;
        }
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
