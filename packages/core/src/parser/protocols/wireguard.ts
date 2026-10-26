import type { ParsedNode } from "@subboost/core/types/node";
import { parseUrlWithNeutralScheme, safeDecodeFormUrlEncoded, safeDecodeURIComponent } from "./url-decode";
import { normalizeProtocolFields, normalizeWireGuardReserved } from "../../mihomo/protocol-fields";

function parseBoolish(value: string | null): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function assignWireGuardAddress(node: Record<string, unknown>, raw: string) {
  for (const item of raw.split(",")) {
    const normalized = item.trim().replace(/\/\d+$/, "").replace(/^\[/, "").replace(/\]$/, "");
    if (!normalized) continue;
    if (normalized.includes(":")) {
      node.ipv6 = normalized;
    } else {
      node.ip = normalized;
    }
  }
}

export function parseWireGuard(uri: string): ParsedNode {
  if (!uri.startsWith("wireguard://") && !uri.startsWith("wg://")) {
    throw new Error("无效的 WireGuard 链接");
  }

  const normalizedUri = uri.replace(/^wg:\/\//, "wireguard://");
  const url = parseUrlWithNeutralScheme(normalizedUri);
  const server = url.hostname;
  const port = Number.parseInt(url.port || "51820", 10);
  const params = url.searchParams;

  const privateKey =
    safeDecodeURIComponent(url.username) ||
    params.get("private-key") ||
    params.get("private_key") ||
    params.get("privateKey") ||
    "";
  const name =
    safeDecodeFormUrlEncoded(url.hash.slice(1)) ||
    `WireGuard ${server}:${port}`;

  if (!server || !privateKey) {
    throw new Error("WireGuard 配置缺少必要字段");
  }
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error("无效的端口号");
  }

  const node = {
    name,
    type: "wireguard",
    server,
    port,
    "private-key": privateKey,
    udp: true,
  } as Record<string, unknown>;

  for (const [rawKey, rawValue] of Array.from(params.entries())) {
    const key = rawKey.replace(/_/g, "-").trim();
    const value = safeDecodeURIComponent(rawValue);
    if (!key || !value) continue;

    if (key === "reserved") {
      const reserved = normalizeWireGuardReserved(value);
      if (reserved) node.reserved = reserved;
      continue;
    }
    if (key === "address" || key === "ip") {
      assignWireGuardAddress(node, value);
      continue;
    }
    if (key === "mtu") {
      const mtu = Number.parseInt(value, 10);
      if (Number.isInteger(mtu)) node.mtu = mtu;
      continue;
    }
    if (/publickey/i.test(key) || key === "peer-public-key") {
      node["public-key"] = value;
      continue;
    }
    if (key === "pre-shared-key" || key === "preshared-key" || key === "presharedkey") {
      node["pre-shared-key"] = value;
      continue;
    }
    if (/privatekey/i.test(key)) {
      node["private-key"] = value;
      continue;
    }
    if (key === "udp") {
      const udp = parseBoolish(value);
      if (udp !== undefined) node.udp = udp;
      continue;
    }
    if (key === "flag") {
      continue;
    }
    if (!(key in node)) {
      node[key] = value;
    }
  }

  return normalizeProtocolFields(node) as unknown as ParsedNode;
}
