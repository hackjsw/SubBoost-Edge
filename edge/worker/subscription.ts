import {
  getClashConversionProfile,
  isClashConversionProfileId,
} from "@subboost/core/subscription/clash-conversion-profiles";
import {
  ACL4SSR_CONFIG_URL,
  CF_NON_TLS_PORTS,
  KV_TTL,
  MAX_REMOTE_SOURCES,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_ITEMS,
  MAX_TEST_NODES,
  REGION_CONFIG,
  TLS_PORTS,
} from "./constants";
import { byteLength, safeBase64Decode, utf8ToBase64 } from "./encoding";
import { json, methodNotAllowed, readJsonBody } from "./http";
import { assertPublicHttpUrl, fetchRemoteText } from "./remote-fetch";
import { convertClashSubscription } from "./subconverter";
import type { EdgeNode, ExecutionContextLike, SubRequestParams, WorkerEnv } from "./types";

type ExtractedNode = {
  host: string;
  port: string;
  name: string;
  protocol: string;
  originalLink: string | null;
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function regionFilterValue(value: unknown): string | string[] | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return undefined;
}

export async function getSubParams(request: Request): Promise<SubRequestParams> {
  const url = new URL(request.url);
  if (request.method === "POST") {
    const body = await readJsonBody(request);
    if (!body) {
      return {
        id: "",
        template: "",
        source: "",
        rawMode: false,
        jsonMode: false,
        dedupMode: true,
      };
    }

    return {
      id: stringValue(body.id),
      template: stringValue(body.template),
      source: stringValue(body.source),
      profile: stringValue(body.profile) || undefined,
      rawMode: body.raw === true,
      jsonMode: body.format === "json",
      filterRegions: regionFilterValue(body.regions),
      defaultRegion: stringValue(body.default_region) || undefined,
      dedupMode: body.dedup !== false,
    };
  }

  return {
    id: url.searchParams.get("id")?.trim() || "",
    template: url.searchParams.get("template")?.trim() || "",
    source: url.searchParams.get("source")?.trim() || "",
    profile: url.searchParams.get("profile")?.trim() || undefined,
    rawMode: url.searchParams.get("raw") === "true",
    jsonMode: url.searchParams.get("format") === "json",
    filterRegions: url.searchParams.get("regions") || undefined,
    defaultRegion: url.searchParams.get("default_region") || undefined,
    dedupMode: url.searchParams.get("dedup") !== "false",
  };
}

export async function handleShorten(request: Request, env: WorkerEnv): Promise<Response> {
  if (!env.SUB_KV) return json({ error: "KV未绑定" }, 400);
  const body = await readJsonBody(request);
  if (!body) return json({ error: "无效的 JSON 请求" }, 400);

  const source = stringValue(body.source);
  if (!source) return json({ error: "节点来源不能为空" }, 400);
  const profile = stringValue(body.profile);
  if (profile && (!isClashConversionProfileId(profile) || profile === "native")) {
    return json({ error: "无效的 Clash 规则方案" }, 400);
  }

  const stored = {
    template: stringValue(body.template),
    source,
    dedup: booleanValue(body.dedup, true),
    ...(profile ? { profile } : {}),
  };
  const bodyString = JSON.stringify(stored);
  if (byteLength(bodyString) > MAX_SOURCE_BYTES) return json({ error: "节点来源过大" }, 413);

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyString));
  const id = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);

  await env.SUB_KV.put(id, bodyString, { expirationTtl: KV_TTL });
  const origin = new URL(request.url).origin;
  return json({ shortUrl: `${origin}/sub?id=${id}`, id, ttl: KV_TTL });
}

async function resolveShortLinkParams(
  params: SubRequestParams,
  env: WorkerEnv,
  ctx?: ExecutionContextLike
): Promise<{ params: SubRequestParams; isShortLink: boolean }> {
  if (!params.id || !env.SUB_KV) return { params, isShortLink: false };

  try {
    const stored = await env.SUB_KV.get(params.id);
    if (!stored) return { params, isShortLink: false };
    const data = JSON.parse(stored) as Record<string, unknown>;
    const resolved = {
      ...params,
      source: stringValue(data.source) || params.source,
      template: typeof data.template === "string" ? data.template : params.template,
      dedupMode: typeof data.dedup === "boolean" ? data.dedup : params.dedupMode,
      profile: typeof data.profile === "string" ? data.profile : params.profile,
    };
    const refresh = env.SUB_KV.put(params.id, stored, { expirationTtl: KV_TTL });
    if (ctx) ctx.waitUntil(refresh);
    else await refresh;
    return { params: resolved, isShortLink: true };
  } catch {
    return { params, isShortLink: false };
  }
}

export function dedupeNodes(nodes: EdgeNode[]): EdgeNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    const key = node.ip && node.port ? `${node.ip}:${node.port}` : node.link;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function prependExpiryHint(nodes: EdgeNode[]): EdgeNode[] {
  if (!nodes.length) return nodes;
  const expiresAt = new Date(Date.now() + KV_TTL * 1000);
  const title = `Expiry ${expiresAt.getUTCMonth() + 1}/${expiresAt.getUTCDate()} ${String(
    expiresAt.getUTCHours()
  ).padStart(2, "0")}:${String(expiresAt.getUTCMinutes()).padStart(2, "0")}`;
  const first = nodes[0];
  let link = first.link;

  if (first.protocol === "vmess") {
    try {
      const config = JSON.parse(safeBase64Decode(link.replace(/^vmess:\/\//i, ""))) as Record<string, unknown>;
      config.ps = title;
      config.add = "www.shopify.com";
      config.port = "443";
      link = `vmess://${utf8ToBase64(JSON.stringify(config))}`;
    } catch {}
  } else {
    try {
      const url = new URL(link);
      url.hostname = "www.shopify.com";
      url.port = "443";
      url.hash = encodeURIComponent(title);
      link = url.toString();
    } catch {
      link = `${link.split("#")[0]}#${encodeURIComponent(title)}`;
    }
  }

  return [
    {
      ip: "www.shopify.com",
      port: "443",
      name: title,
      region: "Info",
      link,
      protocol: first.protocol,
    },
    ...nodes,
  ];
}

function parseNodeList(lines: string[]): ExtractedNode[] {
  const nodes: ExtractedNode[] = [];
  for (const rawLine of lines.slice(0, MAX_SOURCE_ITEMS)) {
    const line = rawLine.trim();
    if (!line) continue;
    let host = "";
    let port = "";
    let name = "";
    let protocol = "";
    let originalLink: string | null = line;

    try {
      if (line.includes("://")) {
        protocol = line.split("://", 1)[0].toLowerCase();
        if (protocol === "vmess") {
          const config = JSON.parse(safeBase64Decode(line.replace(/^vmess:\/\//i, ""))) as Record<string, unknown>;
          host = stringValue(config.add);
          port = String(config.port || "443");
          name = stringValue(config.ps);
        } else if (protocol === "ss" || protocol === "ssr") {
          continue;
        } else {
          const parsed = new URL(line.replace(/^[a-z0-9+\-.]+:\/\//i, "http://"));
          host = parsed.hostname;
          port = parsed.port || "443";
          if (parsed.hash) name = decodeURIComponent(parsed.hash.slice(1));
        }
      } else {
        originalLink = null;
        const match = line.match(/^(.*?)(?:[#|](.*))?$/);
        if (!match) continue;
        const address = match[1].trim();
        name = match[2]?.trim() || "";
        const bracketed = address.match(/^\[([^\]]+)\](?::(\d+))?$/);
        if (bracketed) {
          host = bracketed[1];
          port = bracketed[2] || "443";
        } else {
          const lastColon = address.lastIndexOf(":");
          if (lastColon > 0 && address.indexOf(":") === lastColon) {
            host = address.slice(0, lastColon);
            port = address.slice(lastColon + 1);
          } else {
            host = address;
            port = "443";
          }
        }
      }
    } catch {
      continue;
    }

    if (host) {
      nodes.push({ host, port: port.trim() || "443", name, protocol, originalLink });
    }
  }
  return nodes;
}

async function extractNodes(lines: string[]): Promise<ExtractedNode[]> {
  let remoteCount = 0;
  const tasks = lines.slice(0, MAX_SOURCE_ITEMS).map(async (rawLine) => {
    const line = rawLine.trim();
    if (!line) return [];
    if (!/^https?:\/\//i.test(line)) return parseNodeList([line]);
    remoteCount += 1;
    if (remoteCount > MAX_REMOTE_SOURCES) return [];

    try {
      const result = await fetchRemoteText(line, {
        maxBytes: MAX_SOURCE_BYTES,
        timeoutMs: 15000,
        userAgent: "v2rayN/6.0",
      });
      const decoded = safeBase64Decode(result.content.trim()) || result.content;
      return parseNodeList(decoded.split(/[\n\r]+/).filter(Boolean));
    } catch {
      return [];
    }
  });

  return (await Promise.all(tasks)).flat();
}

export function identifyRegion(name: string, host = ""): string {
  let decodedName = name || "";
  try {
    decodedName = decodeURIComponent(decodedName);
  } catch {}

  const upperName = decodedName.toUpperCase();
  for (const [region, keywords] of Object.entries(REGION_CONFIG)) {
    if (keywords.some((keyword) => upperName.includes(keyword.toUpperCase()))) return region;
  }

  const upperHost = host.toUpperCase();
  const tldMap: Record<string, string> = {
    ".HK": "HK Hong Kong",
    ".TW": "TW Taiwan",
    ".SG": "SG Singapore",
    ".JP": "JP Japan",
    ".US": "US United States",
    ".KR": "KR Korea",
    ".DE": "DE Germany",
    ".FR": "FR France",
    ".UK": "UK United Kingdom",
    ".CA": "CA Canada",
    ".RU": "RU Russia",
  };
  for (const [tld, region] of Object.entries(tldMap)) {
    if (upperHost.endsWith(tld)) return region;
  }

  const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(":");
  return host && !isIp ? "Global CDN" : "Unknown";
}

function extractPath(link: string | null): string | null {
  if (!link) return null;
  const match = link.match(
    /[?&]path=([^#]+?)(?=&(?:type|security|encryption|host|headerType|sni|fp|alpn|pbk|sid|spx|flow|insecure|allowInsecure|ech)=|#|$)/i
  );
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export async function processData(template: string, source: string, defaultRegion?: string): Promise<EdgeNode[]> {
  let templateUrl: URL | null = null;
  let templateProtocol = "vless";
  let vmessTemplate: Record<string, unknown> | null = null;
  let templatePath: string | null = null;

  if (template.includes("://")) {
    try {
      templateProtocol = template.match(/^([a-z0-9+\-.]+):\/\//i)?.[1].toLowerCase() || "vless";
      if (templateProtocol === "vmess") {
        vmessTemplate = JSON.parse(safeBase64Decode(template.replace(/^vmess:\/\//i, ""))) as Record<string, unknown>;
        templateUrl = new URL(`http://${String(vmessTemplate.add)}:${String(vmessTemplate.port)}`);
        templatePath = stringValue(vmessTemplate.path) || null;
      } else {
        templatePath = extractPath(template);
        templateUrl = new URL(template.replace(/^[a-z0-9+\-.]+:\/\//i, "http://"));
      }
    } catch {
      templateUrl = null;
      vmessTemplate = null;
    }
  }

  const rawLines = source.split(/[\n\r,]+/).map((line) => line.trim()).filter(Boolean);
  const extracted = await extractNodes(rawLines);
  const results: EdgeNode[] = [];

  for (const item of extracted) {
    const protocol = item.protocol.toLowerCase();
    if (protocol === "ss" || protocol === "ssr" || item.originalLink?.toLowerCase().startsWith("ss://")) continue;
    const host = item.host.replace(/^\[|\]$/g, "");
    if (!host || host.toLowerCase() === "workers.dev" || host.toLowerCase().endsWith(".workers.dev")) continue;

    const port = item.port || "443";
    let region = identifyRegion(item.name, host);
    if ((region === "Unknown" || region === "Global CDN") && defaultRegion?.trim()) region = defaultRegion.trim();
    const cleanRegion = region.replace(/[^\w\s-]/g, "").trim() || "Node";
    const finalPath = templatePath ?? extractPath(item.originalLink);
    let link = "";
    let name = "";

    if (templateUrl) {
      if (templateProtocol === "vmess" && vmessTemplate) {
        const config = { ...vmessTemplate };
        config.add = host;
        config.port = port;
        config.ps = `${cleanRegion}-${port}-${String(config.net || "tcp").toUpperCase()}`;
        if (CF_NON_TLS_PORTS.has(port)) config.tls = "";
        if (finalPath) config.path = finalPath;
        name = String(config.ps);
        link = `vmess://${utf8ToBase64(JSON.stringify(config))}`;
      } else {
        const next = new URL(templateUrl.toString());
        next.hostname = host;
        next.port = port;
        next.searchParams.delete("path");
        const type = next.searchParams.get("type") || next.searchParams.get("network") || "tcp";
        if (CF_NON_TLS_PORTS.has(port)) {
          next.searchParams.set("security", "none");
          for (const key of ["encryption", "sni", "fp", "alpn"]) next.searchParams.delete(key);
        }
        const security = next.searchParams.get("security") || "none";
        const tls = ["tls", "xtls", "reality", "auto"].includes(security);
        name = `${cleanRegion}-${port}-${type.toUpperCase()}${tls ? "-TLS" : ""}`;
        next.hash = encodeURIComponent(name);
        let base = next.toString().replace(/^http:\/\//, `${templateProtocol}://`);
        if (finalPath) {
          const hashIndex = base.indexOf("#");
          const hash = hashIndex >= 0 ? base.slice(hashIndex) : "";
          const main = hashIndex >= 0 ? base.slice(0, hashIndex) : base;
          base = `${main}${main.includes("?") ? "&" : "?"}path=${encodeURIComponent(finalPath)}${hash}`;
        }
        link = base;
      }
    } else if (item.originalLink) {
      link = item.originalLink;
      name = item.name || `${cleanRegion}-${port}`;
    }

    if (link) {
      results.push({ ip: host, port, name, region, link, protocol: templateUrl ? templateProtocol : protocol || "unknown" });
    }
  }

  return results;
}

function normalizedRegions(filter: string | string[] | undefined): string[] {
  const raw = Array.isArray(filter) ? filter : filter?.split(",") || [];
  return raw.map((region) => region.trim()).filter(Boolean);
}

export async function handleSub(
  request: Request,
  env: WorkerEnv,
  ctx?: ExecutionContextLike
): Promise<Response> {
  const shortResolved = await resolveShortLinkParams(await getSubParams(request), env, ctx);
  const params = shortResolved.params;
  if (!params.source) {
    const message = "配置错误：请检查来源(Source)或短链接ID是否有效";
    if (params.jsonMode) return json({ error: message }, 400);
    return new Response(params.rawMode ? message : utf8ToBase64(message), { status: 400 });
  }
  if (byteLength(params.source) > MAX_SOURCE_BYTES) {
    const message = "节点来源过大";
    if (params.jsonMode) return json({ error: message }, 413);
    return new Response(params.rawMode ? message : utf8ToBase64(message), { status: 413 });
  }

  try {
    let nodes = await processData(params.template, params.source, params.defaultRegion);
    const regions = normalizedRegions(params.filterRegions);
    if (regions.length) nodes = nodes.filter((node) => regions.includes(node.region));
    if (params.dedupMode) nodes = dedupeNodes(nodes);
    if (shortResolved.isShortLink) nodes = prependExpiryHint(nodes);
    if (params.jsonMode) return json(nodes);

    const links = nodes.map((node) => node.link).join("\n");
    return new Response(params.rawMode ? links : utf8ToBase64(links), {
      headers: { "Content-Type": "text/plain;charset=UTF-8", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    const message = `Server Error: ${error instanceof Error ? error.message : String(error)}`;
    if (params.jsonMode) return json({ error: message }, 500);
    const body = params.rawMode ? message : utf8ToBase64(`error://internal?#${encodeURIComponent(message)}`);
    return new Response(body, { status: 500 });
  }
}

export async function handleClash(
  request: Request,
  env: WorkerEnv,
  ctx?: ExecutionContextLike
): Promise<Response> {
  const shortResolved = await resolveShortLinkParams(await getSubParams(request), env, ctx);
  const params = shortResolved.params;
  if (!params.source) return new Response("Error: missing source", { status: 400 });
  let profileConfigUrl: string | null = null;
  if (params.profile) {
    if (!isClashConversionProfileId(params.profile) || params.profile === "native") {
      return new Response("Error: invalid clash profile", { status: 400 });
    }
    profileConfigUrl = getClashConversionProfile(params.profile).configUrl;
  }

  const origin = new URL(request.url).origin;
  const subUrl = new URL("/sub", origin);
  if (params.id) {
    subUrl.searchParams.set("id", params.id);
  } else {
    if (params.template) subUrl.searchParams.set("template", params.template);
    subUrl.searchParams.set("source", params.source);
    const regions = normalizedRegions(params.filterRegions);
    if (regions.length) subUrl.searchParams.set("regions", regions.join(","));
    if (params.defaultRegion) subUrl.searchParams.set("default_region", params.defaultRegion);
    if (!params.dedupMode) subUrl.searchParams.set("dedup", "false");
  }

  const configUrl = profileConfigUrl || env.ACL4SSR_CONFIG_URL || ACL4SSR_CONFIG_URL;
  if (!configUrl) return new Response("Error: invalid clash profile", { status: 400 });

  return convertClashSubscription({
    env,
    sourceUrl: subUrl.toString(),
    configUrl,
    method: request.method === "HEAD" ? "HEAD" : "GET",
  });
}

export async function handleTest(request: Request): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const body = await readJsonBody(request);
  const nodes = Array.isArray(body?.nodes) ? body.nodes : null;
  if (!nodes) return json({ error: "nodes must be an array" }, 400);
  if (nodes.length > MAX_TEST_NODES) return json({ error: `最多测试 ${MAX_TEST_NODES} 个节点` }, 413);

  const results = await Promise.all(
    nodes.map(async (value) => {
      const node = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const target = stringValue(node.ip);
      const port = String(node.port || "443");
      if (!target || !/^\d{1,5}$/.test(port) || Number(port) > 65535) {
        return { ...node, status: "fail", latency: -1 };
      }

      try {
        const scheme = TLS_PORTS.has(port) ? "https" : "http";
        const targetUrl = assertPublicHttpUrl(`${scheme}://${target}:${port}/`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2500);
        const startedAt = Date.now();
        try {
          await fetch(targetUrl, {
            method: "GET",
            headers: { "User-Agent": "EdgeSub/2.6", Accept: "text/html,*/*" },
            signal: controller.signal,
            redirect: "manual",
          });
          return { ...node, status: "ok", latency: Date.now() - startedAt };
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        return { ...node, status: "fail", latency: -1 };
      }
    })
  );

  results.sort((a, b) => {
    if (a.status === "fail" && b.status !== "fail") return 1;
    if (b.status === "fail" && a.status !== "fail") return -1;
    return Number(a.latency) - Number(b.latency);
  });
  return json(results);
}
