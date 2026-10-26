function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeXhttpRange(value: unknown, field: string): string {
  if (typeof value !== "number" && typeof value !== "string") throw new Error(`XHTTP ${field} 需要非负整数或范围`);
  const text = String(value).trim();
  if (text === "") return ""; // Mihomo uses the field's default for an empty range.
  const parts = text.split("-").map(part => part.trim());
  if (parts.length > 2 || parts.some(part => !/^\+?\d+$/.test(part))) throw new Error(`XHTTP ${field} 需要非负整数或范围`);
  const [min, max = min] = parts.map(Number);
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min || max > 2147483647) {
    throw new Error(`XHTTP ${field} 范围无效`);
  }
  return min === max ? String(min) : `${min}-${max}`;
}

export const XHTTP_RANGE_FIELDS = [
  "x-padding-bytes", "session-length", "uplink-chunk-size",
  "sc-max-each-post-bytes", "sc-min-posts-interval-ms",
] as const;

export const XHTTP_REUSE_RANGE_FIELDS = [
  "max-concurrency", "max-connections", "c-max-reuse-times",
  "h-max-request-times", "h-max-reusable-secs",
] as const;

export function normalizeXhttpReuse(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error("XHTTP reuse-settings 需要对象");
  const out = { ...value };
  for (const field of XHTTP_REUSE_RANGE_FIELDS) {
    if (out[field] !== undefined) out[field] = normalizeXhttpRange(out[field], field);
  }
  if (out["h-keep-alive-period"] !== undefined) {
    const raw = out["h-keep-alive-period"];
    const number = typeof raw === "number" ? raw : typeof raw === "string" && /^-?\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(number)) throw new Error("XHTTP h-keep-alive-period 需要整数");
    out["h-keep-alive-period"] = number;
  }
  return out;
}

/** Validate canonical fields without replacing omitted Mihomo defaults. */
export function normalizeXhttpFields(value: Record<string, unknown>): Record<string, unknown> {
  const out = { ...value };
  if (out.mode !== undefined && !["", "auto", "packet-up", "stream-up", "stream-one"].includes(String(out.mode))) {
    throw new Error("XHTTP mode 无效");
  }
  for (const field of XHTTP_RANGE_FIELDS) {
    if (out[field] === undefined) continue;
    const normalized = normalizeXhttpRange(out[field], field);
    if (normalized !== "" && field.startsWith("sc-") && Number(normalized.split("-").at(-1)) === 0) throw new Error(`XHTTP ${field} 必须大于零`);
    // Retain the released numeric scalar shape; ranges must never be truncated.
    out[field] = normalized !== "" && field === "sc-max-each-post-bytes" && !normalized.includes("-") ? Number(normalized) : normalized;
  }
  const enums: Record<string, readonly string[]> = {
    "x-padding-placement": ["queryInHeader", "cookie", "header", "query"],
    "x-padding-method": ["repeat-x", "tokenish"],
    "session-placement": ["path", "query", "cookie", "header"],
    "seq-placement": ["path", "query", "cookie", "header"],
    "uplink-data-placement": ["auto", "body", "cookie", "header"],
  };
  for (const field of ["path", "host", "x-padding-key", "x-padding-header", "uplink-http-method", "session-key", "session-table", "seq-key", "uplink-data-key", ...Object.keys(enums)]) {
    const raw = out[field];
    if (raw === undefined) continue;
    if (typeof raw !== "string" || (raw !== "" && enums[field] && !enums[field].includes(raw))) throw new Error(`XHTTP ${field} 无效`);
  }
  for (const field of ["no-grpc-header", "x-padding-obfs-mode"]) {
    const raw = typeof out[field] === "string" ? (out[field] as string).trim().toLowerCase() : out[field];
    if (raw === undefined) continue;
    if ([true, 1, "1", "true", "yes", "on"].includes(raw as string | number | boolean)) out[field] = true;
    else if ([false, 0, "0", "false", "no", "off"].includes(raw as string | number | boolean)) out[field] = false;
    else throw new Error(`XHTTP ${field} 需要布尔值`);
  }
  if (out.headers !== undefined) {
    if (!isPlainObject(out.headers) || Object.values(out.headers).some(v => typeof v !== "string")) {
      throw new Error("XHTTP headers 需要字符串映射");
    }
  }
  if (out["reuse-settings"] !== undefined) out["reuse-settings"] = normalizeXhttpReuse(out["reuse-settings"]);
  return out;
}
