import { SUBCONVERTER_BACKEND } from "./constants";
import type { WorkerEnv } from "./types";

type ConvertClashSubscriptionOptions = {
  env: WorkerEnv;
  sourceUrl: string;
  configUrl: string;
  method?: "GET" | "HEAD";
  responseHeaders?: HeadersInit;
};

export async function convertClashSubscription({
  env,
  sourceUrl,
  configUrl,
  method = "GET",
  responseHeaders,
}: ConvertClashSubscriptionOptions): Promise<Response> {
  const converterUrl = new URL(env.SUBCONVERTER_BACKEND || SUBCONVERTER_BACKEND);
  if (!converterUrl.pathname || converterUrl.pathname === "/") converterUrl.pathname = "/sub";
  converterUrl.searchParams.set("target", "clash");
  converterUrl.searchParams.set("url", sourceUrl);
  converterUrl.searchParams.set("config", configUrl);
  converterUrl.searchParams.set("emoji", "true");
  converterUrl.searchParams.set("udp", "true");
  converterUrl.searchParams.set("list", "false");

  try {
    const upstream = await fetch(converterUrl, {
      method,
      headers: { "User-Agent": "EdgeSub/2.6" },
      cf: { cacheTtl: 300, cacheEverything: true },
    } as RequestInit);
    const headers = new Headers(upstream.headers);
    new Headers(responseHeaders).forEach((value, key) => headers.set(key, value));
    headers.delete("content-length");
    headers.set("Content-Type", "text/yaml;charset=UTF-8");
    headers.set("X-Content-Type-Options", "nosniff");
    if (!headers.has("Content-Disposition")) {
      headers.set("Content-Disposition", `attachment; filename=clash-${crypto.randomUUID().slice(0, 8)}.yaml`);
    }
    return new Response(method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch {
    return new Response(method === "HEAD" ? null : "Error: subconverter request failed", { status: 502 });
  }
}
