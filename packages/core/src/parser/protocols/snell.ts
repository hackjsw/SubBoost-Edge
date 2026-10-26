import type { ParsedNode } from "@subboost/core/types/node";
import { parseUrlWithNeutralScheme, safeDecodeFormUrlEncoded, safeDecodeURIComponent } from "./url-decode";
import { normalizeProtocolFields } from "../../mihomo/protocol-fields";

function parseBoolish(value: string | null): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

export function parseSnell(uri: string): ParsedNode {
  if (!uri.startsWith("snell://")) {
    throw new Error("无效的 Snell 链接");
  }

  const url = parseUrlWithNeutralScheme(uri);
  const params = url.searchParams;
  const psk = (() => {
    const user = safeDecodeURIComponent(url.username);
    const pass = safeDecodeURIComponent(url.password);
    if (user || pass) {
      return pass ? `${user}:${pass}` : user;
    }
    return (
      params.get("psk") ||
      params.get("password") ||
      params.get("auth") ||
      params.get("auth_str") ||
      params.get("auth-str") ||
      ""
    ).trim();
  })();
  const server = url.hostname;
  const port = Number.parseInt(url.port || "443", 10);
  const name = safeDecodeFormUrlEncoded(url.hash.slice(1)) || `Snell ${server}:${port}`;

  if (!psk || !server) {
    throw new Error("Snell 配置缺少必要字段");
  }
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error("无效的端口号");
  }

  const node = {
    name,
    type: "snell",
    server,
    port,
    psk,
  } as Record<string, unknown>;

  const version = Number.parseInt(params.get("version") || "", 10);
  if (Number.isInteger(version)) node.version = version;

  const obfs = params.get("obfs")?.trim().toLowerCase();
  if (obfs === "http" || obfs === "tls") {
    node["obfs-opts"] = {
      mode: obfs,
      ...(params.get("obfs-host") ? { host: params.get("obfs-host") } : {}),
      ...(params.get("obfs-uri") ? { path: params.get("obfs-uri") } : {}),
    };
  }

  const udp = parseBoolish(params.get("udp-relay"));
  if (udp !== undefined) node.udp = udp;
  const reuse = parseBoolish(params.get("reuse"));
  if (reuse !== undefined) node.reuse = reuse;
  const tfo = parseBoolish(params.get("fast-open")) ?? parseBoolish(params.get("tfo"));
  if (tfo !== undefined) node.tfo = tfo;

  const shadowTlsVersion = Number.parseInt(params.get("shadow-tls-version") || "", 10);
  if (Number.isInteger(shadowTlsVersion)) node["shadow-tls-version"] = shadowTlsVersion;
  if (params.get("shadow-tls-sni")) node["shadow-tls-sni"] = params.get("shadow-tls-sni");
  if (params.get("shadow-tls-password")) node["shadow-tls-password"] = params.get("shadow-tls-password");

  return normalizeProtocolFields(node) as unknown as ParsedNode;
}
