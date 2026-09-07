import { parseSubscription } from "@subboost/core/parser";
import {
  HTML_SUBSCRIPTION_PAGE_ERROR,
  isHtmlSubscriptionPayload,
} from "@subboost/core/parser/preprocess";
import {
  hasClientUpdatePlaceholderError,
  looksLikeClientUpdatePlaceholderNodes,
} from "@subboost/core/parser/placeholder";
import {
  createSubscriptionImportErrorInfo,
  inferSubscriptionImportErrorCategory,
  normalizeSubscriptionImportErrorInfo,
  sanitizePublicErrorText,
  type SubscriptionImportErrorInfo,
} from "@subboost/core/subscription/import-error";
import { tryNormalizeSubscriptionUrlInput } from "@subboost/core/subscription/url-input";
import type { ParseResult, ParsedNode } from "@subboost/core/types/node";
import { shouldTryClashMetaForV2raynPayload } from "./fetch-profile-heuristics";
import { SUBSCRIPTION_IMPORT_USER_AGENTS } from "./user-agents";

export type SourceImportPurpose = "content" | "userinfo";

export type SourceImportTransportRequest = {
  url: string;
  userAgent: string;
  purpose: SourceImportPurpose;
  timeoutMs: number;
  maxBytes: number;
  /** Runtime adapters should use this signal in addition to timeoutMs. */
  signal?: AbortSignal;
};

export type SourceImportTransportResult = {
  ok: boolean;
  content?: string;
  headers?: Record<string, string>;
  error?: string;
  errorInfo?: SubscriptionImportErrorInfo | null;
  responseStatus?: number;
  publicReason?: string | null;
};

export type SourceImportRequest = {
  url: string;
  userinfoUrl?: string;
  userinfoUserAgent?: string;
};

export type SourceImportSuccess = {
  ok: true;
  content: string;
  headers: Record<string, string>;
  parsedNodes: ParsedNode[];
  parseErrors: string[];
};

export type SourceImportFailure = {
  ok: false;
  error: string;
  errorInfo: SubscriptionImportErrorInfo;
  responseStatus?: number;
  publicReason?: string | null;
};

export type SourceImportResult = SourceImportSuccess | SourceImportFailure;

export type SourceImportOptions = {
  timeoutMs?: number;
  totalTimeoutMs?: number;
  maxBytes?: number;
  maxAttempts?: number;
  /** Maximum transport calls, including the optional user-info request. */
  maxRequests?: number;
  /** Backwards-compatible alias for maxRequests. */
  maxSubrequests?: number;
  userinfoMaxBytes?: number;
  userAgents?: readonly string[];
  now?: () => number;
  fetchText: (request: SourceImportTransportRequest) => Promise<SourceImportTransportResult>;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_USERINFO_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS = 8;
const MAX_REQUESTS = 16;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BYTES = 64 * 1024 * 1024;
const IMPORT_TIMEOUT_ERROR = "订阅请求超时";
const IMPORT_BUDGET_ERROR = "订阅请求次数过多";

export function buildSourceImportParseResult(
  result: Pick<SourceImportSuccess, "parsedNodes" | "parseErrors">
): ParseResult {
  const nodes = result.parsedNodes;
  const errors = result.parseErrors;
  return {
    nodes,
    errors,
    totalParsed: nodes.length,
    totalFailed: errors.length,
  };
}

type ParsedAttempt =
  | {
      ok: true;
      userAgent: string;
      content: string;
      headers: Record<string, string>;
      parsed: ParseResult;
    }
  | {
      ok: false;
      userAgent: string;
      error: string;
      html?: boolean;
      errorInfo?: SubscriptionImportErrorInfo | null;
      responseStatus?: number;
      publicReason?: string | null;
    };

function isBrowserUserAgent(userAgent: string): boolean {
  return userAgent.startsWith("Mozilla/");
}

function isHtmlAttempt(attempt: ParsedAttempt): boolean {
  if (attempt.ok) {
    return attempt.parsed.errors.some((error) => error.includes(HTML_SUBSCRIPTION_PAGE_ERROR));
  }
  return attempt.html === true;
}

function createErrorInfo(message: string, httpStatus?: number): SubscriptionImportErrorInfo {
  return createSubscriptionImportErrorInfo({
    category: inferSubscriptionImportErrorCategory(message),
    message,
    detail: message,
    httpStatus,
  });
}

function isUsableParsedAttempt(attempt: ParsedAttempt): attempt is Extract<ParsedAttempt, { ok: true }> {
  return attempt.ok && attempt.parsed.nodes.length > 0 && !looksLikeClientUpdatePlaceholderNodes(attempt.parsed.nodes);
}

function shouldContinueAfterCleanAttempt(params: {
  attempt: ParsedAttempt;
  currentUserAgent: string;
  nextUserAgent?: string;
}): boolean {
  const { attempt, currentUserAgent, nextUserAgent } = params;
  if (isHtmlAttempt(attempt) && nextUserAgent && isBrowserUserAgent(nextUserAgent)) {
    return false;
  }
  if (!isUsableParsedAttempt(attempt) || attempt.parsed.errors.length > 0) return true;
  if (
    currentUserAgent === SUBSCRIPTION_IMPORT_USER_AGENTS[0] &&
    nextUserAgent === SUBSCRIPTION_IMPORT_USER_AGENTS[1]
  ) {
    return shouldTryClashMetaForV2raynPayload(attempt.content, attempt.parsed);
  }
  return false;
}

function toFailure(attempt: ParsedAttempt | null, fallback = "获取 url 失败"): SourceImportFailure {
  if (!attempt) {
    return {
      ok: false,
      error: fallback,
      errorInfo: createErrorInfo(fallback),
    };
  }

  if (!attempt.ok) {
    const message = sanitizePublicErrorText(attempt.error) || fallback;
    const normalizedInfo = normalizeSubscriptionImportErrorInfo(attempt.errorInfo);
    return {
      ok: false,
      error: message,
      errorInfo: normalizedInfo ?? createErrorInfo(message, attempt.responseStatus),
      responseStatus: attempt.responseStatus,
      publicReason: attempt.publicReason ? sanitizePublicErrorText(attempt.publicReason) : null,
    };
  }

  const parseError = attempt.parsed.errors[0] || "未解析到有效节点";
  const message = hasClientUpdatePlaceholderError(attempt.parsed.errors) ||
    looksLikeClientUpdatePlaceholderNodes(attempt.parsed.nodes)
    ? "订阅服务返回了客户端更新提示占位内容，未导入该结果"
    : parseError;
  return {
    ok: false,
    error: message,
    errorInfo: createSubscriptionImportErrorInfo({
      category: "parse",
      message,
      detail: parseError,
    }),
  };
}

function pickBetterAttempt(current: ParsedAttempt | null, next: ParsedAttempt): ParsedAttempt {
  if (!current) return next;
  const currentUsable = isUsableParsedAttempt(current);
  const nextUsable = isUsableParsedAttempt(next);
  if (currentUsable !== nextUsable) return nextUsable ? next : current;
  if (current.ok !== next.ok) return next.ok ? next : current;
  if (!current.ok || !next.ok) return current;
  if (current.parsed.nodes.length !== next.parsed.nodes.length) {
    return next.parsed.nodes.length > current.parsed.nodes.length ? next : current;
  }
  if (current.parsed.errors.length !== next.parsed.errors.length) {
    return next.parsed.errors.length < current.parsed.errors.length ? next : current;
  }
  return current;
}

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const normalizedKey = key.toLowerCase().trim();
    if (!normalizedKey || typeof value !== "string") continue;
    out[normalizedKey] = value;
  }
  return out;
}

function normalizeFiniteInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function createTransportFailure(
  message: string,
  options: { status?: number; category?: "network" | "parse" | "format" | "security" } = {}
): SourceImportTransportResult {
  const safeMessage = sanitizePublicErrorText(message) || "获取 url 失败";
  return {
    ok: false,
    error: safeMessage,
    responseStatus: options.status,
    publicReason: safeMessage,
    errorInfo: createSubscriptionImportErrorInfo({
      category: options.category ?? inferSubscriptionImportErrorCategory(safeMessage),
      message: safeMessage,
      detail: safeMessage,
      httpStatus: options.status,
    }),
  };
}

function isTransportResult(value: unknown): value is SourceImportTransportResult {
  return Boolean(value) && typeof value === "object" && typeof (value as { ok?: unknown }).ok === "boolean";
}

function canonicalUrlKey(value: string): string | null {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    if ((parsed.protocol === "http:" && parsed.port === "80") || (parsed.protocol === "https:" && parsed.port === "443")) {
      parsed.port = "";
    }
    parsed.hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return parsed.toString();
  } catch {
    return null;
  }
}

type TransportCall = {
  result: SourceImportTransportResult;
  /** True only when the shared import deadline, rather than an attempt cap, elapsed. */
  deadlineExpired: boolean;
};

/**
 * Put a hard upper bound around adapters as well as the network primitive.
 * The adapter gets an AbortSignal, but the race is still needed for test
 * doubles and runtimes that do not honor abort while resolving DNS or a body.
 */
async function invokeTransportWithDeadline(
  fetchText: (request: SourceImportTransportRequest) => Promise<SourceImportTransportResult>,
  request: SourceImportTransportRequest,
  deadline: number,
  now: () => number
): Promise<TransportCall> {
  const remainingMs = deadline - now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return { result: createTransportFailure(IMPORT_TIMEOUT_ERROR), deadlineExpired: true };
  }

  const controller = new AbortController();
  const requestedTimeoutMs = normalizeFiniteInteger(request.timeoutMs, remainingMs, 1, MAX_TIMEOUT_MS);
  const callTimeoutMs = Math.max(1, Math.min(requestedTimeoutMs, remainingMs));
  let timerFired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<SourceImportTransportResult>((resolve) => {
    timer = setTimeout(() => {
      timerFired = true;
      controller.abort();
      resolve(createTransportFailure(IMPORT_TIMEOUT_ERROR));
    }, Math.max(1, Math.ceil(callTimeoutMs)));
  });

  try {
    const requestWithSignal = { ...request, signal: controller.signal };
    const transportPromise = Promise.resolve().then(() => fetchText(requestWithSignal));
    const rawResult = await Promise.race([transportPromise, timeoutPromise]);
    if (timerFired || now() >= deadline) {
      const deadlineExpired = now() >= deadline || callTimeoutMs >= remainingMs;
      controller.abort();
      return { result: createTransportFailure(IMPORT_TIMEOUT_ERROR), deadlineExpired };
    }
    if (!isTransportResult(rawResult)) {
      return { result: createTransportFailure("获取 url 失败"), deadlineExpired: false };
    }
    return { result: rawResult, deadlineExpired: false };
  } catch (error) {
    if (timerFired || (error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError")) {
      return {
        result: createTransportFailure(IMPORT_TIMEOUT_ERROR),
        deadlineExpired: timerFired && (now() >= deadline || callTimeoutMs >= remainingMs),
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { result: createTransportFailure(message), deadlineExpired: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function fetchAndParseWithUserAgent(
  url: string,
  userAgent: string,
  options: {
    timeoutMs: number;
    maxBytes: number;
    fetchText: (request: SourceImportTransportRequest) => Promise<SourceImportTransportResult>;
  }
): Promise<ParsedAttempt> {
  let response: SourceImportTransportResult;
  try {
    response = await options.fetchText({
      url,
      userAgent,
      purpose: "content",
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
    });
  } catch (error) {
    response = createTransportFailure(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok || typeof response.content !== "string") {
    const message = sanitizePublicErrorText(response.error) || "获取 url 失败";
    return {
      ok: false,
      userAgent,
      error: message,
      errorInfo: response.errorInfo,
      responseStatus: response.responseStatus,
      publicReason: response.publicReason ?? null,
    };
  }

  const headers = normalizeHeaders(response.headers);
  // Adapters enforce the streaming limit. Keep this second check for custom
  // transports so an injected body cannot bypass the shared boundary.
  if (new TextEncoder().encode(response.content).byteLength > options.maxBytes) {
    const tooLarge = createTransportFailure("订阅响应过大", { status: 413 });
    return {
      ok: false,
      userAgent,
      error: tooLarge.error || "订阅响应过大",
      errorInfo: tooLarge.errorInfo,
      responseStatus: 413,
      publicReason: tooLarge.publicReason,
    };
  }

  let parsed: ParseResult;
  try {
    parsed = parseSubscription(response.content);
  } catch (error) {
    const message = sanitizePublicErrorText(error instanceof Error ? error.message : String(error)) || "解析失败";
    return {
      ok: false,
      userAgent,
      error: message,
      errorInfo: createSubscriptionImportErrorInfo({
        category: "parse",
        message,
        detail: message,
      }),
    };
  }
  if (
    isHtmlSubscriptionPayload(response.content, headers["content-type"]) &&
    parsed.nodes.length === 0
  ) {
    return {
      ok: false,
      userAgent,
      html: true,
      error: HTML_SUBSCRIPTION_PAGE_ERROR,
      errorInfo: createSubscriptionImportErrorInfo({
        category: "parse",
        message: HTML_SUBSCRIPTION_PAGE_ERROR,
        detail: HTML_SUBSCRIPTION_PAGE_ERROR,
        httpStatus: response.responseStatus,
      }),
      responseStatus: response.responseStatus,
    };
  }

  return {
    ok: true,
    userAgent,
    content: response.content,
    headers,
    parsed,
  };
}

async function fetchSupplementalUserInfoHeaders(
  request: SourceImportRequest,
  options: {
    timeoutMs: number;
    maxBytes: number;
    fetchText: (request: SourceImportTransportRequest) => Promise<SourceImportTransportResult>;
  },
  fallbackUrl: string,
  existingHeaders: Record<string, string>
): Promise<Record<string, string>> {
  if (!request.userinfoUrl && !request.userinfoUserAgent) return {};
  const rawUrl = request.userinfoUrl || fallbackUrl;
  const url = tryNormalizeSubscriptionUrlInput(rawUrl);
  if (!url) return {};
  if (
    existingHeaders["subscription-userinfo"] &&
    canonicalUrlKey(url) !== null &&
    canonicalUrlKey(url) === canonicalUrlKey(fallbackUrl)
  ) {
    return {};
  }
  try {
    const response = await options.fetchText({
      url,
      userAgent: request.userinfoUserAgent?.trim() || SUBSCRIPTION_IMPORT_USER_AGENTS[0],
      purpose: "userinfo",
      timeoutMs: Math.min(options.timeoutMs, 8000),
      maxBytes: options.maxBytes,
    });
    if (
      response.ok &&
      typeof response.content === "string" &&
      new TextEncoder().encode(response.content).byteLength > options.maxBytes
    ) {
      return {};
    }
    return response.ok ? normalizeHeaders(response.headers) : {};
  } catch {
    // User-info is supplemental; a failed metadata request must not discard
    // an otherwise valid subscription body.
    return {};
  }
}

export async function importSubscriptionFromUrl(
  request: SourceImportRequest,
  options: SourceImportOptions
): Promise<SourceImportResult> {
  const url = tryNormalizeSubscriptionUrlInput(request.url);
  if (!url) {
    return {
      ok: false,
      error: "无效的 url 格式",
      errorInfo: createSubscriptionImportErrorInfo({
        category: "format",
        message: "无效的 url 格式",
      }),
    };
  }
  const parsedUrl = new URL(url);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return {
      ok: false,
      error: "只支持 HTTP/HTTPS url",
      errorInfo: createSubscriptionImportErrorInfo({
        category: "format",
        message: "只支持 HTTP/HTTPS url",
      }),
    };
  }

  const timeoutMs = normalizeFiniteInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
  const totalTimeoutMs = normalizeFiniteInteger(
    options.totalTimeoutMs,
    timeoutMs,
    1,
    MAX_TIMEOUT_MS
  );
  const maxBytes = normalizeFiniteInteger(options.maxBytes, DEFAULT_MAX_BYTES, 0, MAX_BYTES);
  const userinfoMaxBytes = normalizeFiniteInteger(
    options.userinfoMaxBytes,
    Math.min(maxBytes, DEFAULT_USERINFO_MAX_BYTES),
    0,
    DEFAULT_USERINFO_MAX_BYTES
  );
  const userAgents = (options.userAgents?.length
    ? options.userAgents
    : SUBSCRIPTION_IMPORT_USER_AGENTS
  )
    .filter((agent): agent is string => typeof agent === "string")
    .map((agent) => agent.trim().slice(0, 256))
    .filter(Boolean);
  const effectiveUserAgents = userAgents.length > 0 ? userAgents : SUBSCRIPTION_IMPORT_USER_AGENTS;
  const maxAttempts = normalizeFiniteInteger(
    options.maxAttempts,
    DEFAULT_MAX_ATTEMPTS,
    1,
    Math.min(MAX_ATTEMPTS, effectiveUserAgents.length)
  );
  const configuredRequestBudget = options.maxRequests ?? options.maxSubrequests;
  const maxRequests = normalizeFiniteInteger(
    configuredRequestBudget,
    Math.min(MAX_REQUESTS, maxAttempts + 1),
    0,
    MAX_REQUESTS
  );

  const rawNow = options.now ?? Date.now;
  let lastNow = Number(rawNow());
  if (!Number.isFinite(lastNow)) lastNow = Date.now();
  const now = () => {
    const next = Number(rawNow());
    if (Number.isFinite(next)) lastNow = Math.max(lastNow, next);
    return lastNow;
  };
  const deadline = lastNow + totalTimeoutMs;
  let transportRequests = 0;
  let budgetExceeded = maxRequests === 0;
  let timedOut = false;

  const callTransport = async (
    transportRequest: SourceImportTransportRequest,
    bytes = maxBytes
  ): Promise<SourceImportTransportResult> => {
    if (transportRequests >= maxRequests) {
      budgetExceeded = true;
      return createTransportFailure(IMPORT_BUDGET_ERROR);
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      timedOut = true;
      return createTransportFailure(IMPORT_TIMEOUT_ERROR);
    }
    transportRequests += 1;
    const call = await invokeTransportWithDeadline(
      options.fetchText,
      { ...transportRequest, maxBytes: bytes },
      deadline,
      now
    );
    if (call.deadlineExpired) timedOut = true;
    return call.result;
  };

  let best: ParsedAttempt | null = null;

  for (let index = 0; index < maxAttempts && index < effectiveUserAgents.length; index += 1) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      timedOut = true;
      break;
    }
    if (transportRequests >= maxRequests) {
      budgetExceeded = true;
      break;
    }
    const userAgent = effectiveUserAgents[index];
    const attempt = await fetchAndParseWithUserAgent(url, userAgent, {
      timeoutMs: Math.max(1, Math.min(timeoutMs, remainingMs)),
      maxBytes,
      fetchText: (transportRequest) => callTransport(transportRequest),
    });
    best = pickBetterAttempt(best, attempt);
    if (timedOut) break;
    if (
      !shouldContinueAfterCleanAttempt({
        attempt,
        currentUserAgent: userAgent,
        nextUserAgent: effectiveUserAgents[index + 1],
      })
    ) {
      break;
    }
  }

  if (!best || !best.ok || !isUsableParsedAttempt(best)) {
    const fallback = timedOut || now() >= deadline
      ? IMPORT_TIMEOUT_ERROR
      : budgetExceeded
        ? IMPORT_BUDGET_ERROR
        : undefined;
    // A later shared deadline/budget failure is more actionable than an
    // earlier parse/transport error when no usable attempt exists.
    return fallback ? toFailure(null, fallback) : toFailure(best);
  }

  const remainingMs = deadline - now();
  const supplementalHeaders =
    remainingMs > 0 && !budgetExceeded
      ? await fetchSupplementalUserInfoHeaders(
          request,
          {
            timeoutMs: Math.max(1, Math.min(timeoutMs, remainingMs)),
            maxBytes: userinfoMaxBytes,
            fetchText: (transportRequest) => callTransport(transportRequest, userinfoMaxBytes),
          },
          url,
          best.headers
        )
      : {};

  // A timeout while fetching optional metadata does not invalidate a valid
  // body, but all calls still remain within the same deadline and request cap.

  return {
    ok: true,
    content: best.content,
    headers: Object.entries(supplementalHeaders).reduce(
      (headers, [key, value]) => {
        if (key === "subscription-userinfo" || !(key in headers)) headers[key] = value;
        return headers;
      },
      { ...best.headers }
    ),
    parsedNodes: best.parsed.nodes,
    parseErrors: best.parsed.errors,
  };
}
