import type { SourceType } from "@subboost/ui/store/config-store";

export type DetectedSource =
  | { kind: "urls"; urls: string[] }
  | { kind: "nodes"; content: string; count: number }
  | { kind: "yaml"; content: string }
  | { kind: "base64"; content: string }
  | { kind: "unknown"; content: string };

const NODE_SCHEMES = /^(vless|vmess|trojan|ss|ssr|hysteria2?|hy2|tuic|anytls|wireguard|wg|socks5?|https?proxy|snell|juicity|mieru):\/\//i;

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isHttpUrl(line: string): boolean {
  if (!/^https?:\/\//i.test(line) || /\s/.test(line)) return false;
  try {
    new URL(line);
    return true;
  } catch {
    return false;
  }
}

function looksLikeYaml(text: string): boolean {
  return /^(proxies|proxy-providers|proxy-groups|rules|mixed-port|port)\s*:/m.test(text) || /^\s*-\s*\{?\s*name\s*:/m.test(text);
}

function decodeBase64(text: string): string | null {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 16 || !/^[A-Za-z0-9+/=_-]+$/.test(compact)) return null;
  try {
    const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Classifies pasted text so one paste box can accept every supported input. */
export function detectSource(text: string): DetectedSource {
  const trimmed = text.trim();
  const all = lines(trimmed);
  if (all.length && all.every(isHttpUrl)) return { kind: "urls", urls: all };
  const nodeLines = all.filter((line) => NODE_SCHEMES.test(line));
  if (nodeLines.length && nodeLines.length === all.length) return { kind: "nodes", content: trimmed, count: nodeLines.length };
  if (looksLikeYaml(trimmed)) return { kind: "yaml", content: trimmed };
  const decoded = decodeBase64(trimmed);
  if (decoded && lines(decoded).some((line) => NODE_SCHEMES.test(line))) return { kind: "base64", content: trimmed };
  return { kind: "unknown", content: trimmed };
}

/** Store source type for a detected input; base64 node lists parse as node links. */
export function sourceTypeFor(detected: DetectedSource): SourceType | null {
  if (detected.kind === "urls") return "url";
  if (detected.kind === "yaml") return "yaml";
  if (detected.kind === "nodes" || detected.kind === "base64") return "nodes";
  return null;
}

/** Cloudflare Workers cannot fetch IP-literal URLs (they fail with 403). */
export function isIpLiteralUrl(value: string): boolean {
  try {
    const host = new URL(value.trim()).hostname.replace(/^\[|\]$/g, "");
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
  } catch {
    return false;
  }
}

/** Hides secrets in subscription URLs: query values and long opaque path segments. */
export function maskSubscriptionUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    const path = url.pathname
      .split("/")
      .map((segment) => (segment.length >= 16 && /[0-9]/.test(segment) ? "••••••••" : segment))
      .join("/");
    const query = [...url.searchParams.keys()].map((key) => `${key}=••••••••`).join("&");
    return `${url.protocol}//${url.host}${path}${query ? `?${query}` : ""}`;
  } catch {
    return value;
  }
}
