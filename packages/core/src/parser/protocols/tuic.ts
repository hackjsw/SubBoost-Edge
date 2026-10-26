/**
 * TUIC 协议解析器
 *
 * 支持格式:
 * - tuic://uuid:password@server:port?params#name
 * - tuic://token@server:port?params#name
 */

import type { TuicNode } from "@subboost/core/types/node";
import { parseUrlWithNeutralScheme, safeDecodeFormUrlEncoded, safeDecodeURIComponent } from "./url-decode";

function parseBoolParam(params: URLSearchParams, keys: string[]): boolean {
  return keys.some((key) => {
    const value = params.get(key);
    return value === "1" || value === "true";
  });
}

function parseOptionalBool(params: URLSearchParams, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const raw = params.get(key)?.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(raw ?? "")) return true;
    if (["0", "false", "no", "off"].includes(raw ?? "")) return false;
  }
  return undefined;
}

function parseIntParam(params: URLSearchParams, keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = params.get(key);
    if (!raw) continue;
    const value = Number.parseInt(raw, 10);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function pickParam(params: URLSearchParams, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params.get(key);
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function isUuidLike(value: string | undefined): boolean {
  const raw = (value ?? "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw);
}

export function parseTuic(uri: string): TuicNode {
  if (!uri.startsWith("tuic://")) {
    throw new Error("无效的 TUIC 链接");
  }

  const url = parseUrlWithNeutralScheme(uri);
  const params = url.searchParams;

  const rawUsername = safeDecodeURIComponent(url.username);
  const rawPassword = safeDecodeURIComponent(url.password);
  const server = url.hostname;
  const port = parseInt(url.port || "443", 10);
  const name = safeDecodeFormUrlEncoded(url.hash.slice(1)) || `TUIC-${server}:${port}`;

  const queryUuid = pickParam(params, ["uuid", "user", "username"]);
  const queryPassword = pickParam(params, ["password", "passwd"]);
  const uuid = rawPassword
    ? rawUsername
    : isUuidLike(rawUsername)
      ? rawUsername
      : queryUuid;
  const password = rawPassword || queryPassword;
  const token =
    pickParam(params, ["token", "auth", "auth_str", "auth-str"]) ||
    (!rawPassword && !password && rawUsername ? rawUsername : undefined);

  if (!server || (!token && (!uuid || !password))) {
    throw new Error("TUIC 配置缺少必要字段");
  }

  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new Error("无效的端口号");
  }

  const congestionControl = pickParam(params, ["congestion_control", "congestion-control", "congestionControl"]);
  const udpRelayMode = pickParam(params, ["udp_relay_mode", "udp-relay-mode", "udpRelayMode"]);
  const alpnRaw = params.get("alpn") || "";
  const sni = params.get("sni") || params.get("peer") || undefined;
  const allowInsecure = parseBoolParam(params, [
    "allow_insecure",
    "allowInsecure",
    "allow-insecure",
    "insecure",
  ]);
  const disableSni = parseBoolParam(params, [
    "disable_sni",
    "disable-sni",
    "disableSni",
  ]);
  const fastOpen = parseOptionalBool(params, [
    "fast-open",
    "fast_open",
    "fastOpen",
    "tfo",
  ]);
  const reduceRtt = parseBoolParam(params, [
    "reduce_rtt",
    "reduce-rtt",
    "reduceRtt",
  ]);
  const requestTimeout = parseIntParam(params, [
    "request-timeout",
    "request_timeout",
    "requestTimeout",
  ]);
  const heartbeatInterval = parseIntParam(params, [
    "heartbeat-interval",
    "heartbeat_interval",
    "heartbeatInterval",
  ]);
  const maxOpenStreams = parseIntParam(params, [
    "max-open-streams",
    "max_open_streams",
    "maxOpenStreams",
  ]);
  const maxIdleTime = parseIntParam(params, [
    "max-idle-time",
    "max_idle_time",
    "maxIdleTime",
  ]);

  const node: TuicNode = {
    name,
    type: "tuic",
    server,
    port,
    ...(token ? { token } : { uuid: uuid!, password: password! }),
  };

  if (sni) {
    node.sni = sni;
  }

  if (alpnRaw) {
    const alpnList = alpnRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (alpnList.length > 0) {
      node.alpn = alpnList;
    }
  }

  if (congestionControl) {
    node["congestion-controller"] = congestionControl;
  }

  if (udpRelayMode) {
    node["udp-relay-mode"] = udpRelayMode;
  }

  if (requestTimeout !== undefined) {
    node["request-timeout"] = requestTimeout;
  }

  if (heartbeatInterval !== undefined) {
    node["heartbeat-interval"] = heartbeatInterval;
  }

  if (maxOpenStreams !== undefined) {
    node["max-open-streams"] = maxOpenStreams;
  }

  if (maxIdleTime !== undefined) {
    node["max-idle-time"] = maxIdleTime;
  }

  if (reduceRtt) {
    node["reduce-rtt"] = true;
  }

  if (fastOpen !== undefined) node["fast-open"] = fastOpen;
  const tfo = parseOptionalBool(params, ["tfo"]);
  if (tfo !== undefined) node.tfo = tfo;

  if (allowInsecure) {
    node["skip-cert-verify"] = true;
  }

  if (disableSni) {
    node["disable-sni"] = true;
  }

  return node;
}
