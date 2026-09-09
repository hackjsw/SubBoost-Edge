import { load, dump } from "js-yaml";
import { readResponseTextWithLimit } from "@subboost/server-core/subscription/read-response-text";
import { MAX_STORED_YAML_BYTES, SUBCONVERTER_BACKEND } from "./constants";
import type { WorkerEnv } from "./types";

const BACKEND_TIMEOUT_MS = 8000;
const BACKEND_COOLDOWN_MS = 60_000;
// Best-effort cooldown within one Worker isolate; no KV writes per failed request.
const failedUntil = new Map<string, number>();

// Older subconverters cannot represent VLESS/XHTTP/ECH. Send only names using a
// supported placeholder protocol, then restore the original nodes after grouping.
export function prepareClashTemplateSource(yaml: string) {
  const config = load(yaml) as { proxies?: Array<Record<string, unknown>> } | null;
  const proxies = Array.isArray(config?.proxies) ? config.proxies : [];
  return {
    proxies,
    yaml: proxies.length ? dump({ proxies: proxies.map((node, index) => ({
      name: node.name, type: "trojan", server: "example.com", port: 443,
      password: `template-placeholder-${index}`,
    })) }) : yaml,
  };
}

type ConvertClashSubscriptionOptions = {
  env: WorkerEnv;
  sourceUrl: string;
  configUrl: string;
  method?: "GET" | "HEAD";
  responseHeaders?: HeadersInit;
  requireExplicitBackend?: boolean;
  originalProxies?: Array<Record<string, unknown>>;
};

export async function convertClashSubscription({
  env,
  sourceUrl,
  configUrl,
  method = "GET",
  responseHeaders,
  requireExplicitBackend = false,
  originalProxies,
}: ConvertClashSubscriptionOptions): Promise<Response> {
  const configuredBackend = env.SUBCONVERTER_BACKEND?.trim();
  if (requireExplicitBackend && !configuredBackend) {
    const headers = new Headers(responseHeaders);
    headers.set("Cache-Control", "no-store");
    headers.set("Content-Type", "text/plain;charset=UTF-8");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(method === "HEAD" ? null : "Error: subconverter backend is not configured", {
      status: 503,
      headers,
    });
  }

  const backends = [...new Set([
    configuredBackend || SUBCONVERTER_BACKEND,
    ...(env.SUBCONVERTER_FALLBACK_BACKENDS || "").split(/[\s,]+/).filter(Boolean),
  ])].slice(0, 3);
  const ready = backends.filter((backend) => (failedUntil.get(backend) || 0) <= Date.now());
  const candidates = ready.length ? ready : backends;
  for (const backend of candidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
    try {
      const converterUrl = new URL(backend);
      if (!converterUrl.pathname || converterUrl.pathname === "/") converterUrl.pathname = "/sub";
      converterUrl.searchParams.set("target", "clash");
      converterUrl.searchParams.set("url", sourceUrl);
      converterUrl.searchParams.set("config", configUrl);
      converterUrl.searchParams.set("emoji", originalProxies?.length ? "false" : "true");
      converterUrl.searchParams.set("append_type", "false");
      converterUrl.searchParams.set("udp", "true");
      converterUrl.searchParams.set("list", "false");
      const upstream = await fetch(converterUrl, {
        method: "GET", // HEAD also validates the generated config before returning headers.
        signal: controller.signal,
        headers: { "User-Agent": "EdgeSub/2.6" },
        cf: { cacheTtlByStatus: { "200-299": 300, "300-599": 0 }, cacheEverything: true },
      } as RequestInit);
      if (upstream.status !== 200) {
        await upstream.body?.cancel();
        throw new Error(`HTTP ${upstream.status}`);
      }
      const body = await readResponseTextWithLimit(upstream, MAX_STORED_YAML_BYTES, controller.signal);
      if (!body.ok) throw new Error("Oversized converter response");
      const config = load(body.text) as Record<string, unknown> | null;
      if (!config || !Array.isArray(config.proxies) || !config.proxies.length ||
          !Array.isArray(config["proxy-groups"]) || !config["proxy-groups"].length ||
          !Array.isArray(config.rules) || !config.rules.length) {
        throw new Error("Invalid or empty converter output");
      }
      let yaml = body.text;
      if (originalProxies?.length) {
        const returnedNames = new Set(config.proxies.map((node) => node?.name));
        if (returnedNames.size !== originalProxies.length || config.proxies.length !== originalProxies.length ||
            originalProxies.some((node) => !returnedNames.has(node.name))) {
          throw new Error("Converter changed or dropped node names");
        }
        config.proxies = originalProxies;
        yaml = dump(config, { noRefs: true, lineWidth: -1 });
      }
      failedUntil.delete(backend);
      const headers = new Headers(upstream.headers);
      new Headers(responseHeaders).forEach((value, key) => headers.set(key, value));
      headers.delete("content-length");
      headers.delete("content-encoding");
      headers.delete("etag");
      headers.set("X-SubBoost-Converter", converterUrl.hostname);
      headers.set("Content-Type", "text/yaml;charset=UTF-8");
      headers.set("X-Content-Type-Options", "nosniff");
      if (!headers.has("Content-Disposition")) {
        headers.set("Content-Disposition", `attachment; filename=clash-${crypto.randomUUID().slice(0, 8)}.yaml`);
      }
      return new Response(method === "HEAD" ? null : yaml, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch {
      failedUntil.set(backend, Date.now() + BACKEND_COOLDOWN_MS);
    } finally {
      clearTimeout(timeout);
    }
  }
  const headers = new Headers(responseHeaders);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "text/plain;charset=UTF-8");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Retry-After", "60");
  return new Response(method === "HEAD" ? null : "所有配置的转换后端均暂时不可用或返回无效配置，请稍后重试。", {
    status: 502,
    headers,
  });
}
