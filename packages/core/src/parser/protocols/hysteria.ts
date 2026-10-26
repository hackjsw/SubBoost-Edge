import type { ParsedNode } from "@subboost/core/types/node";
import { parseUrlWithNeutralScheme, safeDecodeFormUrlEncoded } from "./url-decode";

function parseBoolish(value: string | null): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

export function parseHysteria(uri: string): ParsedNode {
  if (!uri.startsWith("hysteria://") && !uri.startsWith("hy://")) {
    throw new Error("无效的 Hysteria 链接");
  }

  const normalizedUri = uri.replace(/^hy:\/\//, "hysteria://");
  const url = parseUrlWithNeutralScheme(normalizedUri);
  const params = url.searchParams;
  const server = url.hostname;
  const port = Number.parseInt(url.port || "443", 10);
  const name = safeDecodeFormUrlEncoded(url.hash.slice(1)) || `Hysteria ${server}:${port}`;

  if (!server) {
    throw new Error("Hysteria 配置缺少必要字段");
  }
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error("无效的端口号");
  }

  const node = {
    name,
    type: "hysteria",
    server,
    port,
    protocol: params.get("protocol") || "udp",
  } as Record<string, unknown>;

  const auth = params.get("auth") || params.get("auth_str") || params.get("auth-str") || params.get("password") || "";
  if (auth.trim()) {
    node["auth-str"] = auth.trim();
  }

  const sni = params.get("sni") || params.get("peer") || undefined;
  if (sni) node.sni = sni;

  const insecure = parseBoolish(params.get("insecure")) ?? parseBoolish(params.get("allowInsecure"));
  if (insecure !== undefined) node["skip-cert-verify"] = insecure;

  const alpn = params.get("alpn");
  if (alpn) {
    const list = alpn.split(",").map((item) => item.trim()).filter(Boolean);
    if (list.length > 0) node.alpn = list;
  }

  const up = params.get("upmbps") || params.get("up") || undefined;
  if (up) node.up = up;
  const down = params.get("downmbps") || params.get("down") || undefined;
  if (down) node.down = down;

  const mport = params.get("mport") || params.get("ports") || undefined;
  if (mport) node.ports = mport;

  const obfsParam = params.get("obfsParam") || params.get("obfs-param") || undefined;
  if (obfsParam) node.obfs = obfsParam;

  const obfs = params.get("obfs");
  if (obfs !== null) {
    node["_obfs"] = obfs;
  }

  const fastOpen = parseBoolish(params.get("fast-open") ?? params.get("fast_open") ?? params.get("fastOpen"));
  if (fastOpen !== undefined) node["fast-open"] = fastOpen;
  const tfo = parseBoolish(params.get("tfo"));
  if (tfo !== undefined) node.tfo = tfo;

  return node as unknown as ParsedNode;
}
