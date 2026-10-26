/**
 * Hysteria2 协议解析器
 * 
 * 格式: 
 * - hysteria2://auth@server:port?params#name
 * - hy2://auth@server:port?params#name
 */

import type { Hysteria2Node } from "@subboost/core/types/node";
import { normalizePortsSpec, pickStablePortFromPorts } from "../port-spec";
import { safeDecodeFormUrlEncoded, safeDecodeURIComponent } from "./url-decode";
import { buildMihomoEchOptsFromShareValue } from "../../mihomo/ech";

function parseHopIntervalParam(params: URLSearchParams, keys: string[]): number | string | undefined {
  for (const key of keys) {
    const raw = params.get(key)?.trim();
    if (!raw) continue;
    if (/^\d+$/.test(raw)) {
      const value = Number.parseInt(raw, 10);
      if (Number.isFinite(value) && value > 0) return value;
      continue;
    }

    const range = /^(\d+)-(\d+)$/.exec(raw);
    if (!range) continue;
    const min = Number.parseInt(range[1], 10);
    const max = Number.parseInt(range[2], 10);
    if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max >= min) {
      return `${min}-${max}`;
    }
  }
  return undefined;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

function splitAuthority(value: string): { userInfo: string; server: string; portSpec: string } {
  const raw = trimTrailingSlashes(value.trim());
  if (!raw) return { userInfo: "", server: "", portSpec: "" };

  const atIndex = raw.lastIndexOf("@");
  const userInfo = atIndex === -1 ? "" : raw.slice(0, atIndex);
  const hostPort = atIndex === -1 ? raw : raw.slice(atIndex + 1);

  if (hostPort.startsWith("[")) {
    const end = hostPort.indexOf("]");
    if (end !== -1) {
      const server = hostPort.slice(1, end);
      const rest = hostPort.slice(end + 1);
      if (rest.startsWith(":")) {
        return { userInfo, server, portSpec: trimTrailingSlashes(rest.slice(1)) };
      }
      return { userInfo, server, portSpec: "" };
    }
  }

  const colonIndex = hostPort.lastIndexOf(":");
  if (colonIndex === -1) {
    return { userInfo, server: hostPort, portSpec: "" };
  }
  return {
    userInfo,
    server: hostPort.slice(0, colonIndex),
    portSpec: trimTrailingSlashes(hostPort.slice(colonIndex + 1)),
  };
}

export function parseHysteria2(uri: string): Hysteria2Node {
  if (!uri.startsWith("hysteria2://") && !uri.startsWith("hy2://")) {
    throw new Error("无效的 Hysteria2 链接");
  }

  // 统一处理两种前缀
  const normalizedUri = uri.replace(/^hy2:\/\//, "hysteria2://");

  const rest = normalizedUri.replace(/^hysteria2:\/\//, "");
  const hashIndex = rest.indexOf("#");
  const hash = hashIndex === -1 ? "" : rest.slice(hashIndex + 1);
  const withoutHash = hashIndex === -1 ? rest : rest.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf("?");
  const authority = (queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex)).trim();
  const queryString = queryIndex === -1 ? "" : withoutHash.slice(queryIndex + 1);

  const params = new URLSearchParams(queryString);
  const name = safeDecodeFormUrlEncoded(hash) || "Hysteria2 节点";

  const { userInfo, server: authorityServer, portSpec } = splitAuthority(authority);
  const server = authorityServer.trim();

  const password = (() => {
    const user = safeDecodeURIComponent(userInfo);
    if (user) return user;

    const fromQuery =
      params.get("password") ||
      params.get("auth") ||
      params.get("auth_str") ||
      params.get("auth-str") ||
      "";
    return fromQuery.trim();
  })();

  if (!password || !server) {
    throw new Error("Hysteria2 配置缺少必要字段");
  }

  const queryPortsRaw = (params.get("ports") || params.get("mport") || "").trim();
  const authorityPortsRaw = portSpec && !/^\d+$/.test(portSpec) ? portSpec : "";

  const ports = queryPortsRaw
    ? normalizePortsSpec(queryPortsRaw)
    : authorityPortsRaw
      ? normalizePortsSpec(authorityPortsRaw)
      : undefined;

  const port = (() => {
    if (portSpec && /^\d+$/.test(portSpec)) {
      const p = Number.parseInt(portSpec, 10);
      if (!Number.isFinite(p) || p <= 0 || p > 65535) throw new Error("无效的端口号");
      return p;
    }
    if (ports) return pickStablePortFromPorts(ports);
    return 443;
  })();

  const sni = params.get("sni") || params.get("peer") || server;
  const insecure =
    params.get("insecure") === "1" ||
    params.get("insecure") === "true" ||
    params.get("allowInsecure") === "1" ||
    params.get("allowInsecure") === "true" ||
    params.get("allow_insecure") === "1" ||
    params.get("allow_insecure") === "true";
  const obfsValue = params.get("obfs")?.trim().toLowerCase();
  const obfs = obfsValue === "none" ? undefined : obfsValue || undefined;
  const obfsPassword =
    params.get("obfs-password") || params.get("obfs_password") || params.get("obfsPassword") || undefined;
  const portsFromQuery = ports;
  const alpnRaw = (params.get("alpn") || "").trim();
  const fingerprint = (params.get("fp") || params.get("fingerprint") || params.get("pinSHA256") || "").trim();
  const hopInterval = parseHopIntervalParam(params, ["hop-interval", "hop_interval", "hopInterval"]);
  const mldsa65Seed =
    params.get("mldsa65-seed") || params.get("mldsa65_seed") || params.get("mldsa65Seed") || undefined;
  
  // 带宽限制
  const up = params.get("up") || params.get("upmbps") || undefined;
  const down = params.get("down") || params.get("downmbps") || undefined;

  const node: Hysteria2Node = {
    name,
    type: "hysteria2",
    server,
    port,
    password,
    sni,
  };

  if (insecure) {
    node["skip-cert-verify"] = true;
  }

  if (obfs && !["salamander", "gecko"].includes(obfs)) {
    throw new Error(`不支持的 Hysteria2 obfs: ${obfs}`);
  }
  if (obfs && !obfsPassword) throw new Error(`Hysteria2 ${obfs} obfs 缺少 obfs-password`);
  if (obfs) {
    node.obfs = obfs;
    if (obfsPassword) {
      node["obfs-password"] = obfsPassword;
    }
  }

  for (const field of ["obfs-min-packet-size", "obfs-max-packet-size"] as const) {
    const raw = params.get(field) ?? params.get(field.replaceAll("-", "_"));
    if (raw === null) continue;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new Error(`Hysteria2 ${field} 需要非负整数`);
    }
    node[field] = Number(raw);
  }
  if (params.has("ech")) node["ech-opts"] = buildMihomoEchOptsFromShareValue(params.get("ech"));

  if (alpnRaw) {
    const list = alpnRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 0) node.alpn = list;
  }

  if (fingerprint) {
    node.fingerprint = fingerprint;
  }

  if (up) {
    node.up = /[kmg]?bps$/i.test(up) ? up : `${up} mbps`;
  }

  if (down) {
    node.down = /[kmg]?bps$/i.test(down) ? down : `${down} mbps`;
  }

  if (portsFromQuery) {
    node.ports = portsFromQuery.trim() || undefined;
  }

  if (hopInterval !== undefined) {
    node["hop-interval"] = hopInterval;
  }

  if (mldsa65Seed) {
    node["mldsa65-seed"] = mldsa65Seed;
  }

  return node;
}

