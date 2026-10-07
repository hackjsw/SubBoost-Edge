import safeRegex from "safe-regex2";
import type { ParsedNode } from "../types/node";
import { getNodeOriginName } from "./node-source-state";

export const NODE_NAME_FILTER_MAX_REGEXES = 20;
export const NODE_NAME_FILTER_MAX_REGEX_LENGTH = 200;
// safe-regex2 only rejects nested quantifiers; these extra limits keep matching
// cheap enough for scheduled refreshes on Cloudflare Workers (10 ms CPU budget).
export const NODE_NAME_FILTER_MAX_UNBOUNDED_QUANTIFIERS = 3;
export const NODE_NAME_FILTER_MAX_SUBJECT_LENGTH = 128;

export type NodeNameFilterConfig = {
  enabled: boolean;
  includeEnabled?: boolean;
  excludeEnabled?: boolean;
  includeRegexes?: string[];
  excludeRegexes: string[];
};

export const DEFAULT_NODE_NAME_FILTER_CONFIG: NodeNameFilterConfig = {
  enabled: false,
  excludeRegexes: [],
};

export type NodeNameFilterValidationErrorCode =
  | "invalid_config"
  | "invalid_line"
  | "too_many_regexes"
  | "regex_too_long"
  | "invalid_regex"
  | "unsafe_regex";

export type NodeNameFilterValidationError = {
  code: NodeNameFilterValidationErrorCode;
  message: string;
  line?: number;
  field?: "includeRegexes" | "excludeRegexes";
};

export type NodeNameFilterValidationResult =
  | {
      ok: true;
      config: NodeNameFilterConfig;
    }
  | {
      ok: false;
      errors: NodeNameFilterValidationError[];
    };

export type NodeNameFilterResult = {
  rawNodes: ParsedNode[];
  effectiveNodes: ParsedNode[];
  excludedNodes: ParsedNode[];
  rawCount: number;
  excludedCount: number;
  effectiveCount: number;
};

type ParsedNodeNameFilterConfig = {
  config: NodeNameFilterConfig;
  compiledRegexes: RegExp[];
  compiledIncludes: RegExp[];
};

export class NodeNameFilterConfigError extends Error {
  readonly errors: NodeNameFilterValidationError[];

  constructor(errors: NodeNameFilterValidationError[]) {
    const first = errors[0];
    const detail = first
      ? `${first.line ? `第 ${first.line} 行：` : ""}${first.message}`
      : "配置格式无效";
    super(`节点名称过滤配置无效：${detail}`);
    this.name = "NodeNameFilterConfigError";
    this.errors = errors;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Flags patterns that can still backtrack heavily after passing safe-regex2:
 * a repeated group containing alternation (e.g. `(\w|\d)+`) or more than a few
 * unbounded quantifiers (e.g. `.*.*.*.*x`).
 */
export function hasCostlyRegexShape(pattern: string): boolean {
  const groups: boolean[] = [];
  let lastGroupHadAlternation = false;
  let unbounded = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "\\") {
      i += 1;
      lastGroupHadAlternation = false;
      continue;
    }
    if (char === "[") {
      for (i += 1; i < pattern.length && pattern[i] !== "]"; i += 1) {
        if (pattern[i] === "\\") i += 1;
      }
      lastGroupHadAlternation = false;
      continue;
    }
    if (char === "(") {
      groups.push(false);
      continue;
    }
    if (char === "|") {
      if (groups.length > 0) groups[groups.length - 1] = true;
      continue;
    }
    if (char === ")") {
      const hadAlternation = groups.pop() ?? false;
      if (hadAlternation && groups.length > 0) groups[groups.length - 1] = true;
      lastGroupHadAlternation = hadAlternation;
      continue;
    }
    const brace = char === "{" ? /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i)) : null;
    const isUnbounded = char === "*" || char === "+" || Boolean(brace && brace[2] !== undefined && brace[3] === "");
    const repeats = isUnbounded || Boolean(brace && Number(brace[3] ?? brace[1]) > 1);
    if (repeats && lastGroupHadAlternation) return true;
    if (isUnbounded) unbounded += 1;
    if (unbounded > NODE_NAME_FILTER_MAX_UNBOUNDED_QUANTIFIERS) return true;
    if (brace) i += brace[0].length - 1;
    lastGroupHadAlternation = false;
  }
  return false;
}

function defaultConfig(): NodeNameFilterConfig {
  return {
    enabled: DEFAULT_NODE_NAME_FILTER_CONFIG.enabled,
    excludeRegexes: [],
  };
}

function inspectNodeNameFilterConfig(
  value: unknown
):
  | { ok: true; parsed: ParsedNodeNameFilterConfig }
  | { ok: false; errors: NodeNameFilterValidationError[] } {
  if (value === undefined) {
    return {
      ok: true,
      parsed: {
        config: defaultConfig(),
        compiledRegexes: [],
        compiledIncludes: [],
      },
    };
  }

  if (!isRecord(value)) {
    return {
      ok: false,
      errors: [{ code: "invalid_config", message: "配置必须是对象" }],
    };
  }

  const errors: NodeNameFilterValidationError[] = [];
  const includes = value.includeRegexes === undefined
    ? undefined
    : inspectNodeNameFilterConfig({ enabled: true, excludeRegexes: value.includeRegexes });
  if (includes && !includes.ok) {
    return { ok: false, errors: includes.errors.map((error) => ({ ...error, field: "includeRegexes" })) };
  }
  const includeRegexes = includes?.ok ? includes.parsed.config.excludeRegexes : [];
  const enabled = value.enabled === true;
  for (const field of ["includeEnabled", "excludeEnabled"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      errors.push({ code: "invalid_config", message: `${field} 必须是布尔值` });
    }
  }
  if (typeof value.enabled !== "boolean") {
    errors.push({ code: "invalid_config", message: "enabled 必须是布尔值" });
  }
  if (!Array.isArray(value.excludeRegexes)) {
    errors.push({ code: "invalid_config", message: "excludeRegexes 必须是字符串数组" });
  }
  if (errors.length > 0 || !Array.isArray(value.excludeRegexes)) {
    return { ok: false, errors };
  }

  const excludeRegexes: string[] = [];
  const compiledRegexes: RegExp[] = [];
  const seen = new Set<string>();
  let reportedTooMany = false;

  for (let index = 0; index < value.excludeRegexes.length; index += 1) {
    const line = index + 1;
    const rawPattern = value.excludeRegexes[index];
    if (typeof rawPattern !== "string") {
      errors.push({
        code: "invalid_line",
        line,
        message: "规则必须是文本",
      });
      continue;
    }

    const pattern = rawPattern.trim();
    if (!pattern || seen.has(pattern)) continue;
    seen.add(pattern);

    if (seen.size > NODE_NAME_FILTER_MAX_REGEXES) {
      if (!reportedTooMany) {
        errors.push({
          code: "too_many_regexes",
          line,
          message: `最多允许 ${NODE_NAME_FILTER_MAX_REGEXES} 条规则`,
        });
        reportedTooMany = true;
      }
      continue;
    }

    if (pattern.length > NODE_NAME_FILTER_MAX_REGEX_LENGTH) {
      errors.push({
        code: "regex_too_long",
        line,
        message: `每条规则最多 ${NODE_NAME_FILTER_MAX_REGEX_LENGTH} 个字符`,
      });
      continue;
    }

    let compiled: RegExp;
    try {
      compiled = new RegExp(pattern, "i");
    } catch {
      errors.push({
        code: "invalid_regex",
        line,
        message: "正则语法无效",
      });
      continue;
    }

    if (!safeRegex(compiled) || hasCostlyRegexShape(pattern)) {
      errors.push({
        code: "unsafe_regex",
        line,
        message: "正则可能导致运行时间过长",
      });
      continue;
    }

    excludeRegexes.push(pattern);
    compiledRegexes.push(compiled);
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    parsed: {
      config: {
        enabled: enabled && (excludeRegexes.length > 0 || includeRegexes.length > 0),
        ...(value.includeEnabled !== undefined ? { includeEnabled: value.includeEnabled === true } : {}),
        ...(value.excludeEnabled !== undefined ? { excludeEnabled: value.excludeEnabled === true } : {}),
        ...(includeRegexes.length > 0 ? { includeRegexes } : {}),
        excludeRegexes,
      },
      compiledRegexes: value.excludeEnabled === false ? [] : compiledRegexes,
      compiledIncludes: value.includeEnabled !== false && includes?.ok ? includes.parsed.compiledRegexes : [],
    },
  };
}

export function validateNodeNameFilterConfig(value: unknown): NodeNameFilterValidationResult {
  const result = inspectNodeNameFilterConfig(value);
  return result.ok
    ? { ok: true, config: result.parsed.config }
    : { ok: false, errors: result.errors };
}

export function parseNodeNameFilterConfig(value: unknown): NodeNameFilterConfig {
  const result = inspectNodeNameFilterConfig(value);
  if (!result.ok) throw new NodeNameFilterConfigError(result.errors);
  return result.parsed.config;
}

export function normalizeNodeNameFilterConfig(value: unknown): NodeNameFilterConfig {
  const result = inspectNodeNameFilterConfig(value);
  return result.ok ? result.parsed.config : defaultConfig();
}

export function resolveNodeNameFilter(
  rawNodes: ParsedNode[],
  configValue: unknown
): NodeNameFilterResult {
  const parsed = inspectNodeNameFilterConfig(configValue);
  if (!parsed.ok) throw new NodeNameFilterConfigError(parsed.errors);

  if (!parsed.parsed.config.enabled) {
    return {
      rawNodes,
      effectiveNodes: rawNodes,
      excludedNodes: [],
      rawCount: rawNodes.length,
      excludedCount: 0,
      effectiveCount: rawNodes.length,
    };
  }

  const effectiveNodes: ParsedNode[] = [];
  const excludedNodes: ParsedNode[] = [];
  for (const node of rawNodes) {
    const originName = getNodeOriginName(node).slice(0, NODE_NAME_FILTER_MAX_SUBJECT_LENGTH);
    const { compiledIncludes, compiledRegexes } = parsed.parsed;
    if ((compiledIncludes.length > 0 && !compiledIncludes.some((regex) => regex.test(originName))) ||
        compiledRegexes.some((regex) => regex.test(originName))) {
      excludedNodes.push(node);
    } else {
      effectiveNodes.push(node);
    }
  }

  return {
    rawNodes,
    effectiveNodes,
    excludedNodes,
    rawCount: rawNodes.length,
    excludedCount: excludedNodes.length,
    effectiveCount: effectiveNodes.length,
  };
}
