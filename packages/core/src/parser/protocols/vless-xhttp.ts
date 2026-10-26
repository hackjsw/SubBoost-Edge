import type { XHttpDownloadSettings, XHttpOpts } from "../../types/node";
import { normalizeXhttpFields, normalizeXhttpReuse, XHTTP_RANGE_FIELDS, XHTTP_REUSE_RANGE_FIELDS } from "../../mihomo/xhttp";
import { normalizeMihomoRealityPublicKey } from "../../mihomo/proxy-sanitizer";
import { normalizeRealityShortId } from "../../mihomo/reality";
import { parseJsonObject } from "../json-utils";

const EXTRA_FIELDS: Record<string, string> = {
  headers: "headers", noGRPCHeader: "no-grpc-header", xPaddingBytes: "x-padding-bytes",
  xPaddingObfsMode: "x-padding-obfs-mode", xPaddingKey: "x-padding-key",
  xPaddingHeader: "x-padding-header", xPaddingPlacement: "x-padding-placement",
  xPaddingMethod: "x-padding-method", uplinkHTTPMethod: "uplink-http-method",
  sessionIDPlacement: "session-placement", sessionIDKey: "session-key",
  sessionIDTable: "session-table", sessionIDLength: "session-length",
  seqPlacement: "seq-placement", seqKey: "seq-key",
  uplinkDataPlacement: "uplink-data-placement", uplinkDataKey: "uplink-data-key",
  uplinkChunkSize: "uplink-chunk-size", scMaxEachPostBytes: "sc-max-each-post-bytes",
  scMinPostsIntervalMs: "sc-min-posts-interval-ms",
};
const REUSE_FIELDS: Record<string, string> = {
  maxConcurrency: "max-concurrency", maxConnections: "max-connections",
  cMaxReuseTimes: "c-max-reuse-times", hMaxRequestTimes: "h-max-request-times",
  hMaxReusableSecs: "h-max-reusable-secs", hKeepAlivePeriod: "h-keep-alive-period",
};
// These fields affect download GET requests but cannot be overridden by Mihomo.
const DOWNLOAD_SHARED_DEFAULTS: Record<string, unknown> = {
  "x-padding-bytes": "100-1000", "x-padding-obfs-mode": false,
  "x-padding-key": "x_padding", "x-padding-header": "X-Padding", "x-padding-placement": "queryInHeader",
  "x-padding-method": "repeat-x", "session-placement": "path",
  "session-key": "", "seq-placement": "path",
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`XHTTP ${label} 需要 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function jsonObject(raw: string, label: string): Record<string, unknown> {
  const parsed = parseJsonObject(raw);
  if (!parsed) throw new Error(`XHTTP ${label} 需要有效 JSON 对象`);
  return parsed;
}

function mapFields(source: Record<string, unknown>, names: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(names).filter(([key]) => source[key] !== undefined)
    .map(([key, target]) => [target, source[key]]));
}

function sourceRange(value: unknown, field: string): string {
  const text = (typeof value === "number" || typeof value === "string" ? String(value) : "invalid").trim().split("-").map(part => part.trim()).join("-") || "0";
  if (!/^\+?\d+(?:-\+?\d+)?$/.test(text)) throw new Error(`XHTTP ${field} 需要非负整数或范围`);
  const values = text.split("-").map(Number).sort((a, b) => a - b);
  const [min, max = min] = values;
  if (!Number.isSafeInteger(max) || max > 2147483647) throw new Error(`XHTTP ${field} 范围无效`);
  return min === max ? String(min) : `${min}-${max}`;
}

function mapReuse(value: unknown): Record<string, unknown> {
  const mapped = mapFields(object(value ?? {}, "xmux"), REUSE_FIELDS);
  for (const key of XHTTP_REUSE_RANGE_FIELDS) if (mapped[key] !== undefined) mapped[key] = sourceRange(mapped[key], key);
  return normalizeXhttpReuse(mapped);
}

function applySourceDefaults(input: Record<string, unknown>): Record<string, unknown> {
  const out = normalizeXhttpFields(input);
  const reuse = normalizeXhttpReuse(out["reuse-settings"] ?? {});
  const max = (key: string) => Number(String(reuse[key] || "0").split("-").at(-1));
  if (max("max-concurrency") > 0 && max("max-connections") > 0) throw new Error("XHTTP xmux maxConcurrency 与 maxConnections 不能同时大于零");
  if (XHTTP_REUSE_RANGE_FIELDS.every(key => max(key) === 0) && !reuse["h-keep-alive-period"]) {
    Object.assign(reuse, { "max-connections": "3", "h-max-request-times": "600-900", "h-max-reusable-secs": "1800-3000" });
  }
  out["reuse-settings"] = reuse;
  out["session-table"] ||= "uuid";
  if (out["session-table"] !== "uuid" && Number(String(out["session-length"] || "0").split("-")[0]) === 0) throw new Error("XHTTP sessionIDTable 需要正数 sessionIDLength");
  if (out["uplink-http-method"] !== undefined) out["uplink-http-method"] = String(out["uplink-http-method"]).toUpperCase() || "POST";
  const placement = out["uplink-data-placement"] || "auto";
  if (!out["uplink-data-key"] && placement !== "body") out["uplink-data-key"] = placement === "cookie" ? "x_data" : "X-Data";
  if (placement === "header" && (!out["uplink-chunk-size"] || out["uplink-chunk-size"] === "0")) out["uplink-chunk-size"] = "3000-4000";
  if (out["x-padding-obfs-mode"] === true) {
    for (const key of ["x-padding-key", "x-padding-header", "x-padding-placement", "x-padding-method"]) out[key] ||= DOWNLOAD_SHARED_DEFAULTS[key];
  }
  return out;
}

function mapExtra(source: Record<string, unknown>, defaults = true): Record<string, unknown> {
  const out = mapFields(source, EXTRA_FIELDS);
  for (const field of XHTTP_RANGE_FIELDS) if (out[field] !== undefined) out[field] = sourceRange(out[field], field);
  for (const [field, fallback] of Object.entries({ "x-padding-bytes": "100-1000", "sc-max-each-post-bytes": "1000000", "sc-min-posts-interval-ms": "30" })) {
    if (out[field] === "0") out[field] = fallback;
  }
  if (String(out["x-padding-bytes"] ?? "1").split("-").some(part => Number(part) === 0)) throw new Error("XHTTP xPaddingBytes 不能包含零端点");
  out["reuse-settings"] = mapReuse(source.xmux);
  const table = stringField(source, "sessionIDTable");
  if (table === "uuid") throw new Error("XHTTP sessionIDTable 字符表 uuid 无法由 Mihomo 同名保留字表达");
  if (source.headers !== undefined) {
    const headers = object(source.headers, "headers");
    if (Object.keys(headers).some(key => key.toLowerCase() === "host")) {
      throw new Error("XHTTP Host 请使用 host 字段，不要放在 extra.headers 中");
    }
  }
  return defaults ? applySourceDefaults(out) : normalizeXhttpFields(out);
}

function effectiveSharedField(options: Record<string, unknown>, key: string, fallback: unknown): unknown {
  if (key.startsWith("x-padding-") && !["x-padding-bytes", "x-padding-obfs-mode"].includes(key) && !options["x-padding-obfs-mode"]) return fallback;
  if (key === "session-key") {
    const placement = options["session-placement"];
    if (!options[key] && placement === "header") return "X-Session";
    if (!options[key] && (placement === "cookie" || placement === "query")) return "x_session";
  }
  const value = options[key];
  return value === undefined || value === "" ? fallback : value;
}

function stringField(source: Record<string, unknown>, key: string, fallback = ""): string {
  if (source[key] === undefined) return fallback;
  if (typeof source[key] !== "string") throw new Error(`XHTTP ${key} 需要字符串`);
  return source[key] as string;
}

function mapDownload(value: unknown, main: XHttpOpts): XHttpDownloadSettings {
  const source = object(value, "downloadSettings");
  const network = stringField(source, "network", "xhttp");
  if (network !== "xhttp" && network !== "splithttp") throw new Error("XHTTP 下行仅支持 xhttp/splithttp 网络");
  const server = stringField(source, "address").trim();
  const port = typeof source.port === "string" && /^\d+$/.test(source.port) ? Number(source.port) : source.port;
  if (!server || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("XHTTP downloadSettings 需要有效 address 和 port");
  }
  const security = stringField(source, "security", "none");
  if (!["", "none", "tls", "reality"].includes(security)) throw new Error("XHTTP 下行 security 不受支持");
  for (const key of ["sockopt", "finalmask"]) {
    if (source[key] !== undefined) throw new Error(`XHTTP 下行 ${key} 无法转换为 Mihomo 设置`);
  }
  const transport = object(source.xhttpSettings ?? source.splithttpSettings ?? {}, "下行 xhttpSettings");
  const effective = transport.extra === undefined ? transport : object(transport.extra, "下行 extra");
  const mapped = mapExtra(effective);
  // Mihomo only overrides these transport fields on the download connection.
  for (const [key, fallback] of Object.entries(DOWNLOAD_SHARED_DEFAULTS)) {
    if (effectiveSharedField(mapped, key, fallback) !== effectiveSharedField(main, key, fallback)) {
      throw new Error(`XHTTP 下行独立 ${key} 无法由 Mihomo 表达`);
    }
  }
  if (effective.downloadSettings !== undefined) throw new Error("XHTTP 不支持嵌套 downloadSettings");
  const tls = object((security === "reality" ? source.realitySettings : source.tlsSettings) ?? {}, "下行安全设置");
  for (const key of ["echConfigList", "echForceQuery", "echServerKeys", "echSockopt", "mldsa65Verify", "pinnedPeerCertSha256", "verifyPeerCertByName", "pinnedPeerCertificateChainSha256", "certificates", "verifyPeerCertInNames", "disableSystemRoot", "useSystemCA", "minVersion", "maxVersion", "cipherSuites", "curvePreferences", "enableSessionResumption"]) {
    const value = tls[key];
    if (value !== undefined && value !== false && value !== "" && value !== null && !(Array.isArray(value) && value.length === 0)) throw new Error(`XHTTP 下行 ${key} 无法转换为 Mihomo 设置`);
  }
  const path = stringField(transport, "path", "/") || "/";
  if (path.includes("?")) throw new Error("XHTTP 下行 path 查询参数无法由 Mihomo 表达");
  const alpn = tls.alpn ?? [];
  if (!Array.isArray(alpn) || alpn.some(v => typeof v !== "string")) throw new Error("XHTTP 下行 alpn 需要字符串数组");
  if (tls.allowInsecure !== undefined && typeof tls.allowInsecure !== "boolean") {
    throw new Error("XHTTP 下行 allowInsecure 需要布尔值");
  }
  const result: XHttpDownloadSettings = {
    server, port, tls: security === "tls" || security === "reality",
    servername: stringField(tls, "serverName"),
    "client-fingerprint": stringField(tls, "fingerprint", security === "reality" ? "chrome" : ""),
    "skip-cert-verify": tls.allowInsecure === true, alpn,
    "ech-opts": { enable: false },
    path, host: stringField(transport, "host"),
    headers: (mapped.headers ?? {}) as Record<string, string>,
    "reuse-settings": (mapped["reuse-settings"] ?? {}) as XHttpDownloadSettings["reuse-settings"],
    "reality-opts": { "public-key": "" },
  };
  if (security === "reality") {
    const publicKey = normalizeMihomoRealityPublicKey(tls.password || tls.publicKey);
    if (!publicKey) throw new Error("XHTTP 下行 Reality 缺少有效 publicKey/password");
    const shortId = normalizeRealityShortId(tls.shortId);
    result["reality-opts"] = { "public-key": publicKey, ...(shortId ? { "short-id": shortId } : {}) };
    const support = tls["support-x25519mlkem768"];
    if (support !== undefined) {
      if (typeof support !== "boolean") throw new Error("XHTTP 下行 Reality support-x25519mlkem768 需要布尔值");
      result["reality-opts"]!["support-x25519mlkem768"] = support;
    }
  }
  return result;
}

/** Standard extra plus the released flat aliases; explicit query fields win. */
export function mergeXhttpExtra(params: URLSearchParams, legacy: XHttpOpts): XHttpOpts {
  const extra = params.has("extra") ? jsonObject(params.get("extra")!, "extra") : {};
  const isSource = params.has("extra") || params.has("downloadSettings");
  const mapped = isSource ? mapExtra(extra, false) : {};
  let result = { ...mapped, ...legacy } as XHttpOpts;
  if (mapped.headers || legacy.headers) result.headers = { ...mapped.headers as Record<string, string>, ...legacy.headers };
  if (mapped["reuse-settings"] || legacy["reuse-settings"]) {
    result["reuse-settings"] = { ...mapped["reuse-settings"] as Record<string, unknown>, ...legacy["reuse-settings"] };
  }
  // Also accept unambiguous camelCase and kebab/underscore flat spellings.
  for (const [source, target] of Object.entries({ ...EXTRA_FIELDS, ...REUSE_FIELDS })) {
    if (["headers", "no-grpc-header"].includes(target)) continue;
    const raw = [target, target.replaceAll("-", "_"), source].map(key => params.get(key)).find(v => v !== null && v !== "");
    if (raw === undefined) continue;
    if (source in REUSE_FIELDS) result["reuse-settings"] = { ...result["reuse-settings"], [target]: raw };
    else result[target] = raw;
  }
  if (params.has("noGRPCHeader")) result["no-grpc-header"] = params.get("noGRPCHeader") as unknown as boolean;
  if (isSource) result = applySourceDefaults(result) as XHttpOpts;
  if (params.has("extra") && result.path?.includes("?")) throw new Error("XHTTP path 查询参数无法由 Mihomo 表达");
  if (params.has("extra") && result.mode !== "packet-up" &&
      (["header", "cookie"].includes(String(result["uplink-data-placement"])) || result["uplink-http-method"] === "GET")) {
    throw new Error("XHTTP header/cookie 上传及 GET 需要显式 packet-up 模式");
  }
  let download = extra.downloadSettings;
  if (params.has("downloadSettings")) download = jsonObject(params.get("downloadSettings")!, "downloadSettings");
  if (download !== undefined) {
    result["download-settings"] = { ...mapDownload(download, normalizeXhttpFields(result) as XHttpOpts), ...legacy["download-settings"] };
  }
  if (result.mode === "stream-one" && result["download-settings"]) throw new Error("XHTTP stream-one 不支持 downloadSettings");
  return normalizeXhttpFields(result) as XHttpOpts;
}
