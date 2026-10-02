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
import { load as loadYaml } from "js-yaml";
import { validateProxyReferences } from "@subboost/core/generator/validate-references";
import { generateClashYaml } from "@subboost/core/generator";
import { isMihomoSupportedProxyNode } from "@subboost/core/mihomo/proxy-sanitizer";
import { buildGenerateOptionsFromConfig } from "@subboost/core/subscription/config-utils";
import { getSubscriptionFormat, type SubscriptionFormat } from "@subboost/core/subscription/output-format";
import { buildV2rayNResponse } from "@subboost/server-core/subscription/output-response";
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
  INTERNAL_AUTH_HEADER,
  INTERNAL_REFRESH_PATH,
  MAX_CRON_DISPATCHES,
  SUBSCRIPTION_CRON_INTERVAL_SECONDS,
  SUBSCRIPTION_SCHEDULE_GRACE_MS,
} from "./constants";
import { byteLength } from "./encoding";
import { isAuthenticated, sessionSecret } from "./auth";
import { json, methodNotAllowed, readJsonBody } from "./http";
import { fetchRemoteText } from "./remote-fetch";
import { createStoredConfigCapability, type StoredConfigCapability } from "./stored-config-capability";
import {
  convertedConfigCacheKey,
  readConvertedConfig,
  serveConvertedConfig,
  storeConvertedConfig,
} from "./converted-config-cache";
import { readStoredValue, writeStoredValue } from "./subscription-store";
import {
  invalidateStoredConfigCache,
  loadStoredConfigResponse,
  storedConfigCacheKey,
} from "./stored-config-cache";
import { convertClashSubscription, prepareClashTemplateSource } from "./subconverter";
import type { ExecutionContextLike, ServiceBindingLike, WorkerEnv } from "./types";

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
  staleUserInfoSourceIds?: string[];
};

type SubscriptionScheduleMetadata = {
  version: typeof SUBSCRIPTION_METADATA_VERSION;
  autoUpdate: boolean;
  nextUpdateAt?: string;
};

export type ScheduledUpdateSummary = {
  scanned: number;
  due: number;
  // Due records left for the next run because of the per-run dispatch cap.
  deferred: number;
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

function validateStoredNodes(nodes: unknown[]): Response | null {
  if (nodes.length > MAX_MANAGED_SUBSCRIPTION_NODES) return json({ error: "节点数量超过订阅上限" }, 413);
  for (const node of nodes) {
    if (!isRecord(node) || typeof node.name !== "string" || !node.name.trim()
      || typeof node.type !== "string" || !node.type.trim() || !isMihomoSupportedProxyNode(node)) {
      return json({ error: "节点名称、类型或协议必填字段无效" }, 400);
    }
    if (["direct", "reject", "dns"].includes(String(node.type))) continue;
    const endpoints = node.type === "wireguard" && Array.isArray(node.peers) && node.peers.length ? node.peers : [node];
    if (endpoints.some(endpoint => !isRecord(endpoint) || typeof endpoint.server !== "string" || !endpoint.server.trim()
      || typeof endpoint.port !== "number" || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535)) {
      return json({ error: "节点必须具有有效的服务器地址和端口" }, 400);
    }
  }
  return null;
}

function validateStoredYaml(yaml: string): Response | null {
  let parsed: unknown;
  try {
    parsed = loadYaml(yaml);
  } catch {
    return json({ error: "配置文件不是有效的 YAML" }, 400);
  }
  if (!isRecord(parsed)) return json({ error: "配置必须是 YAML 对象" }, 400);
  const proxies = parsed.proxies;
  if (proxies !== undefined && !Array.isArray(proxies)) return json({ error: "配置中的 proxies 必须是数组" }, 400);
  const nodeError = validateStoredNodes((proxies ?? []) as unknown[]);
  if (nodeError) return nodeError;
  const rawGroups = parsed["proxy-groups"];
  if (rawGroups !== undefined && (!Array.isArray(rawGroups) || !rawGroups.every(group => isRecord(group) && typeof group.type === "string" && group.type.trim()))) {
    return json({ error: "配置中的 proxy-groups 必须是具有类型的对象数组" }, 400);
  }
  const providers = parsed["proxy-providers"];
  if (providers !== undefined && (!isRecord(providers) || !Object.entries(providers).every(([name, provider]) => {
    if (!name.trim() || !isRecord(provider)) return false;
    if (provider.type === "http") {
      try { return typeof provider.url === "string" && ["http:", "https:"].includes(new URL(provider.url).protocol); }
      catch { return false; }
    }
    if (provider.type === "file") return typeof provider.path === "string" && Boolean(provider.path.trim());
    return provider.type === "inline" && Array.isArray(provider.payload) && provider.payload.length > 0 && !validateStoredNodes(provider.payload);
  }))) {
    return json({ error: "配置中的 proxy-providers 定义无效" }, 400);
  }
  // Explicit proxies: [] remains valid for a deliberately direct-only snapshot.
  if (proxies === undefined && (!isRecord(providers) || Object.keys(providers).length === 0)) return json({ error: "配置缺少 proxies 或 proxy-providers" }, 400);
  try { validateProxyReferences(parsed); }
  catch (error) { return json({ error: error instanceof Error ? error.message : "配置引用无效" }, 400); }
  return null;
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
      ...(Array.isArray(raw.staleUserInfoSourceIds) ? { staleUserInfoSourceIds: normalizeStringList(raw.staleUserInfoSourceIds) } : {}),
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
  const dueBy = now.getTime() + SUBSCRIPTION_SCHEDULE_GRACE_MS;
  if (Number.isFinite(explicitNext)) return explicitNext <= dueBy;

  const baseline = Date.parse(record.lastSuccessAt || record.updatedAt || record.createdAt);
  return !Number.isFinite(baseline) || baseline + record.autoUpdateInterval * 1000 <= dueBy;
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
  if (env.SUB_STORE) {
    invalidateStoredConfigCache(token);
    return writeStoredValue(env, token, expected, JSON.stringify(record), subscriptionScheduleMetadata(record));
  }
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
  if (env.SUB_STORE) {
    invalidateStoredConfigCache(token);
    return writeStoredValue(env, token, expected, null);
  }
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
  return !Number.isFinite(nextUpdateAt) || nextUpdateAt <= now.getTime() + SUBSCRIPTION_SCHEDULE_GRACE_MS;
}

function scheduleMetadataMatches(metadata: unknown, record: StoredSubscription): boolean {
  if (!isRecord(metadata)) return false;
  const expected = subscriptionScheduleMetadata(record);
  return (
    metadata.version === expected.version &&
    metadata.autoUpdate === expected.autoUpdate &&
    metadata.nextUpdateAt === expected.nextUpdateAt
  );
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
            ...(source.userAgent ? { userAgent: source.userAgent } : {}),
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
      staleUserInfoSourceIds: snapshot.staleUserInfoSourceIds ?? [],
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
    version: "2.6.0-edge.7",
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
        ...(typeof body?.userAgent === "string" && body.userAgent.trim()
          ? { userAgent: body.userAgent.trim().slice(0, 200) }
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
  let yaml = typeof body.yaml === "string" ? body.yaml : "";
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
  if (body.nodes !== undefined && !Array.isArray(body.nodes)) return { response: json({ error: "nodes 必须是数组" }, 400) };
  if (body.config !== undefined && !isRecord(body.config)) return { response: json({ error: "config 必须是对象" }, 400) };
  const nodeValidationError = validateStoredNodes((body.nodes ?? []) as unknown[]);
  if (nodeValidationError) return { response: nodeValidationError };
  const nodes = normalizeStoredNodes(body.nodes);
  const yamlValidationError = validateStoredYaml(yaml);
  if (yamlValidationError) return { response: yamlValidationError };
  const config = isRecord(body.config) ? body.config : {};
  if (Array.isArray(body.nodes) || hasRefreshSource(config, urls)) {
    try {
      // Structured saves and refreshes share one generator. Client YAML can be
      // stale after an edit, so the saved node/config snapshot is authoritative.
      const options = buildGenerateOptionsFromConfig(config, { nodes });
      if (nodes.length === 0 && !options.proxyProviders) return { response: json({ error: "请先导入有效节点或配置节点提供者" }, 400) };
      yaml = generateClashYaml(options);
    } catch (error) {
      return { response: json({ error: error instanceof Error ? error.message : "配置生成失败" }, 400) };
    }
    if (byteLength(yaml) > MAX_STORED_YAML_BYTES) return { response: json({ error: "配置文件过大" }, 413) };
    const generatedValidationError = validateStoredYaml(yaml);
    if (generatedValidationError) return { response: generatedValidationError };
  }
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

// Nodes the user removed in the editor stay in the record but are not served.
function activeNodeCount(record: StoredSubscription): number {
  const deleted = new Set<string>();
  const { deletedNodeNames, deletedNodes } = record.config;
  if (Array.isArray(deletedNodeNames)) {
    for (const name of deletedNodeNames) if (typeof name === "string") deleted.add(name.trim());
  }
  if (Array.isArray(deletedNodes)) {
    for (const item of deletedNodes) {
      if (isRecord(item) && typeof item.originName === "string") deleted.add(item.originName.trim());
    }
  }
  if (!deleted.size) return record.nodes.length;
  return record.nodes.filter((node) => {
    const origin = (node as { originName?: unknown }).originName;
    return !deleted.has((typeof origin === "string" && origin.trim()) || node.name);
  }).length;
}

function publicUsage(info: SubscriptionResponseInfo) {
  const { upload, download, total, expire } = info;
  if ([upload, download, total, expire].every((value) => value === undefined)) return null;
  return {
    usedBytes: upload !== undefined || download !== undefined ? (upload ?? 0) + (download ?? 0) : null,
    totalBytes: total ?? null,
    expireAt: expire ? new Date(expire * 1000).toISOString() : null,
  };
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
      lastError: record.lastError ?? null,
    },
    smartNodeMatchingEnabled: record.config.smartNodeMatchingEnabled !== false,
    lastUpdatedAt: record.lastSuccessAt || record.updatedAt,
    lastAccessedAt: null,
    createdAt: record.createdAt,
    persistent: true,
    nextUpdateAt: record.nextUpdateAt ?? null,
    template: typeof record.config.template === "string" ? record.config.template : null,
    nodeCount: activeNodeCount(record),
    usage: publicUsage(record.subscriptionInfo),
  };
}

async function loadStoredSubscription(
  env: WorkerEnv,
  token: string
): Promise<{ record: StoredSubscription; migrated: boolean; stored: string } | null> {
  if (!env.SUB_KV || !TOKEN_PATTERN.test(token)) return null;
  let stored: string | null;
  try {
    stored = (await readStoredValue(env, token)).value;
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
  if (env.SUB_STORE) {
    const created = await writeStoredValue(env, token, null, stored, subscriptionScheduleMetadata(record));
    return created ? null : json({ error: "订阅标识冲突，请重试" }, 409);
  }
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
    const autoUpdateInterval = Object.prototype.hasOwnProperty.call(body, "autoUpdateInterval")
      ? normalizeAutoUpdateInterval(body.autoUpdateInterval)
      : record.autoUpdateInterval;
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
    if (autoUpdateInterval !== record.autoUpdateInterval) {
      delete next.lastError;
      if (autoUpdateInterval) next.nextUpdateAt = nextUpdateTime(new Date(), autoUpdateInterval);
      else delete next.nextUpdateAt;
    }

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
  const format = getSubscriptionFormat(request.url);
  // Check the authoritative revision before reusing an isolate-local response.
  // A write or deletion in another isolate must not leave an old config active.
  let snapshot: Awaited<ReturnType<typeof readStoredValue>> | undefined;
  if (env.SUB_STORE) {
    try { snapshot = await readStoredValue(env, token); }
    catch { return storedConfigError("Stored subscription is unavailable", 503, method); }
    if (snapshot.value === null) return storedConfigError("Subscription not found", 404, method);
  }
  const response = await loadStoredConfigResponse(
    storedConfigCacheKey(token, method, raw, format) + (snapshot?.revision ? `:${snapshot.revision}` : ""),
    { method },
    () => loadStoredConfigFromKv(request, env, token, method, raw, format, ctx, snapshot?.value ?? undefined)
  );
  return notModifiedIfMatching(request, response);
}

// Clients that send If-None-Match get a bodyless 304 when nothing changed.
// Kept outside the isolate cache so one client's 304 is never reused for another.
function notModifiedIfMatching(request: Request, response: Response): Response {
  const etag = response.headers.get("ETag");
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (response.status !== 200 || !etag || !ifNoneMatch) return response;
  if (!ifNoneMatch.split(",").some(candidate => candidate.trim() === etag || candidate.trim() === "*")) return response;
  void response.body?.cancel();
  const headers = new Headers({ ETag: etag, "Cache-Control": "no-store" });
  for (const name of ["profile-update-interval", "subscription-userinfo", "Content-Disposition"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(null, { status: 304, headers });
}

async function storedRevision(stored: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stored));
  return Array.from(new Uint8Array(digest).slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("");
}

// Serves the placeholder template behind a sealed capability. The revision
// pins the snapshot whose real proxies the converter response is merged with.
export async function resolveStoredConfigCapability(
  env: WorkerEnv,
  capability: StoredConfigCapability
): Promise<string | null> {
  if (!env.SUB_KV || !TOKEN_PATTERN.test(capability.token)) return null;
  const stored = (await readStoredValue(env, capability.token)).value;
  if (!stored || (await storedRevision(stored)) !== capability.revision) return null;
  const parsed = parseStoredSubscription(stored);
  return parsed ? prepareClashTemplateSource(parsed.record.yaml).yaml : null;
}

async function loadStoredConfigFromKv(
  request: Request,
  env: WorkerEnv,
  token: string,
  method: "GET" | "HEAD",
  raw: boolean,
  format: SubscriptionFormat,
  ctx?: ExecutionContextLike,
  prefetched?: string
): Promise<Response> {
  const kv = env.SUB_KV;
  if (!kv) return storedConfigError("KV is not configured", 503, method);
  const key = `${CONFIG_KEY_PREFIX}${token}`;
  let stored: string | null;
  try {
    stored = prefetched ?? (await readStoredValue(env, token)).value;
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
        // Content cannot change faster than the cron runs; don't ask clients to poll faster.
        cacheExpirySeconds: SUBSCRIPTION_CRON_INTERVAL_SECONDS,
        isAdmin: true,
        cacheControl: "no-store",
      })
    );
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-SubBoost-Storage", "persistent-kv");
    headers.set("X-SubBoost-Auto-Update", record.autoUpdateInterval ? "enabled" : "disabled");
    headers.set("X-SubBoost-Last-Updated", record.updatedAt);
    headers.set("X-SubBoost-Stale-Userinfo", String(record.staleUserInfoSourceIds?.length ?? 0));
    if (record.nextUpdateAt) headers.set("X-SubBoost-Next-Update", record.nextUpdateAt);

    const revision = await storedRevision(stored);
    if (format === "v2rayn") {
      headers.set("ETag", `"${revision}-v2rayn"`);
      return buildV2rayNResponse(record.yaml, headers, method);
    }

    if (!raw) {
      const profile = getClashConversionProfile(record.conversionProfileId);
      if (profile.configUrl) {
        // A stored config URL is persistent bearer access; only forward its
        // short-lived capability to an explicitly configured converter.
        if (!env.SUBCONVERTER_BACKEND?.trim()) {
          return storedConfigError("Subconverter backend is not configured", 503, method);
        }
        const cacheKey = convertedConfigCacheKey(request.url, token, revision);
        const cached = await readConvertedConfig(cacheKey);
        // A fresh hit skips the converter round trip and the YAML merge entirely.
        if (cached?.fresh) return serveConvertedConfig(cached.response, method, "hit");

        const templateSource = prepareClashTemplateSource(record.yaml);
        let sourceUrl: string;
        try {
          sourceUrl = await createStoredConfigCapability(env, request.url, { token, revision });
        } catch {
          return storedConfigError("Session secret is not configured", 503, method);
        }
        const converted = await convertClashSubscription({
          env,
          sourceUrl,
          configUrl: profile.configUrl,
          method: "GET",
          requireExplicitBackend: true,
          responseHeaders: headers,
          originalProxies: templateSource.proxies,
          originalConfig: templateSource.config,
        });
        if (converted.status === 200) {
          const body = await converted.text();
          const convertedAt = Date.now();
          // The template can change while the revision does not, so the ETag
          // follows the conversion, not just the stored record.
          converted.headers.set("ETag", `"${revision}-c${convertedAt}"`);
          const store = storeConvertedConfig(cacheKey, body, converted.headers, convertedAt);
          if (ctx) ctx.waitUntil(store);
          else await store;
          converted.headers.set("X-SubBoost-Converter-Cache", "miss");
          return new Response(method === "HEAD" ? null : body, { status: 200, headers: converted.headers });
        }
        if (converted.status !== 502) return converted;

        // Every converter failed: an older conversion of this revision beats an
        // error, and the native config (same nodes, built-in rules) beats both.
        await converted.body?.cancel();
        if (cached) return serveConvertedConfig(cached.response, method, "stale");
        headers.set("X-SubBoost-Converter-Fallback", "native");
        headers.set("ETag", `"${revision}-native"`);
        headers.set("Content-Length", String(byteLength(record.yaml)));
        return new Response(method === "HEAD" ? null : record.yaml, { headers });
      }
    }

    headers.set("ETag", `"${revision}${raw ? "-raw" : ""}"`);
    headers.set("Content-Length", String(byteLength(record.yaml)));
    return new Response(method === "HEAD" ? null : record.yaml, { headers });
  } catch {
    return storedConfigError("Stored subscription is invalid", 500, method);
  }
}

// "raced": the record was due but changed while refreshing, so the result was dropped.
type ScheduledOutcome = "updated" | "failed" | "skipped" | "raced";

// Handles one listed record. Runs either inline in the cron invocation or in
// its own invocation via the SELF service binding (one CPU budget each).
async function processScheduledSubscription(
  env: WorkerEnv,
  token: string,
  keyMetadata: unknown,
  now: Date
): Promise<ScheduledOutcome> {
  const keyName = `${CONFIG_KEY_PREFIX}${token}`;
  try {
    const stored = (await readStoredValue(env, token)).value;
    if (!stored) return "skipped";
    const parsed = parseStoredSubscription(stored);
    if (!parsed) return "skipped";

    let expectedStored = stored;
    if (parsed.migrated) {
      const migrated = await putStoredSubscriptionIfUnchanged(env, token, keyName, expectedStored, parsed.record);
      if (!migrated) return "skipped";
      expectedStored = JSON.stringify(parsed.record);
    }

    if (!isUpdateDue(parsed.record, now)) {
      // Only backfill missing or stale schedule metadata; rewriting an
      // unchanged record would cost a KV write per subscription per run.
      if (!parsed.migrated && !scheduleMetadataMatches(keyMetadata, parsed.record)) {
        await putStoredSubscriptionIfUnchanged(env, token, keyName, expectedStored, parsed.record);
      }
      return "skipped";
    }

    const refreshed = await refreshStoredSubscription(parsed.record, now);
    const persisted = await putStoredSubscriptionIfUnchanged(env, token, keyName, expectedStored, refreshed.record);
    if (!persisted) return "raced";
    return refreshed.ok ? "updated" : "failed";
  } catch {
    return "failed";
  }
}

function internalRefreshAuth(env: WorkerEnv, token: string): Promise<string> {
  return signInternal(env, `edgesub:internal-refresh:${token}`);
}

async function signInternal(env: WorkerEnv, message: string): Promise<string> {
  const secret = sessionSecret(env);
  if (!secret) throw new Error("Session secret is not configured");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

async function dispatchScheduledSubscription(
  env: WorkerEnv,
  self: ServiceBindingLike,
  token: string,
  keyMetadata: unknown,
  now: Date
): Promise<ScheduledOutcome> {
  try {
    const response = await self.fetch(new Request(`https://edgesub.internal${INTERNAL_REFRESH_PATH}${token}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [INTERNAL_AUTH_HEADER]: await internalRefreshAuth(env, token),
      },
      body: JSON.stringify({ metadata: keyMetadata ?? null, now: now.toISOString() }),
    }));
    const data = (await response.json().catch(() => ({}))) as { outcome?: unknown };
    if (!response.ok) return "failed";
    return data.outcome === "updated" || data.outcome === "skipped" || data.outcome === "raced" ? data.outcome : "failed";
  } catch {
    // Includes a child invocation killed for exceeding its CPU limit.
    return "failed";
  }
}

export async function handleInternalSubscriptionRefresh(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const token = new URL(request.url).pathname.slice(INTERNAL_REFRESH_PATH.length);
  if (!env.SUB_KV || !TOKEN_PATTERN.test(token)) return json({ error: "Not found" }, 404);
  let expected: string;
  try {
    expected = await internalRefreshAuth(env, token);
  } catch {
    return json({ error: "Not found" }, 404);
  }
  if (!timingSafeEqualText(request.headers.get(INTERNAL_AUTH_HEADER) || "", expected)) {
    return json({ error: "Not found" }, 404);
  }
  const body = (await request.json().catch(() => ({}))) as { metadata?: unknown; now?: unknown };
  // Keep the cron's schedule time, but never trust a time far from reality.
  const requested = typeof body.now === "string" ? Date.parse(body.now) : Number.NaN;
  const now = Number.isFinite(requested) && Math.abs(requested - Date.now()) < 15 * 60 * 1000
    ? new Date(requested)
    : new Date();
  return json({ outcome: await processScheduledSubscription(env, token, body.metadata, now) });
}

export async function runScheduledSubscriptionUpdates(
  env: WorkerEnv,
  now = new Date()
): Promise<ScheduledUpdateSummary> {
  if (!env.SUB_KV) throw new Error("KV is not configured");
  const summary: ScheduledUpdateSummary = { scanned: 0, due: 0, updated: 0, failed: 0, skipped: 0, deferred: 0 };
  const candidates: Array<{ token: string; metadata: unknown; dueAt: number }> = [];
  let cursor: string | undefined;

  do {
    const page = await env.SUB_KV.list({
      prefix: CONFIG_KEY_PREFIX,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });

    for (const key of page.keys) {
      summary.scanned += 1;
      // KV metadata is mirrored on every write, so a valid "not due" entry is
      // trusted without reading (and parsing) the record.
      if (metadataUpdateDue(key.metadata, now) === false) {
        summary.skipped += 1;
        continue;
      }
      const next = isRecord(key.metadata) && typeof key.metadata.nextUpdateAt === "string"
        ? Date.parse(key.metadata.nextUpdateAt)
        : Number.NaN;
      candidates.push({
        token: key.name.slice(CONFIG_KEY_PREFIX.length),
        metadata: key.metadata,
        dueAt: Number.isFinite(next) ? next : 0,
      });
    }

    if (page.list_complete || !page.cursor || page.cursor === cursor) break;
    cursor = page.cursor;
  } while (cursor);

  // Most overdue first, so records deferred by the per-run cap go next time.
  candidates.sort((a, b) => a.dueAt - b.dueAt);
  const self = env.SELF && sessionSecret(env) ? env.SELF : undefined;
  let dispatched = 0;
  for (const candidate of candidates) {
    if (self && dispatched >= MAX_CRON_DISPATCHES) {
      summary.deferred += 1;
      continue;
    }
    if (self) dispatched += 1;
    const outcome = self
      ? await dispatchScheduledSubscription(env, self, candidate.token, candidate.metadata, now)
      : await processScheduledSubscription(env, candidate.token, candidate.metadata, now);
    if (outcome !== "skipped") summary.due += 1;
    if (outcome === "skipped" || outcome === "raced") summary.skipped += 1;
    else summary[outcome] += 1;
  }

  return summary;
}
