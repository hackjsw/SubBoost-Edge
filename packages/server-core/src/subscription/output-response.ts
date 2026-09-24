import { generateV2rayNSubscription } from "@subboost/core/generator/v2rayn";

export function buildV2rayNResponse(yaml: string, responseHeaders: HeadersInit, method = "GET"): Response {
  const headers = new Headers(responseHeaders);
  headers.set("Content-Type", "text/plain;charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.delete("Content-Length");
  try {
    const result = generateV2rayNSubscription(yaml);
    headers.set("Content-Length", String(new TextEncoder().encode(result.content).byteLength));
    headers.set("X-SubBoost-Format", "v2rayn");
    headers.set("X-SubBoost-Node-Count", String(result.nodeCount));
    headers.set("X-SubBoost-Skipped-Nodes", String(result.skippedNodes.length));
    headers.set("X-SubBoost-Skipped-Providers", String(result.providerCount));
    return new Response(method === "HEAD" ? null : result.content, { headers });
  } catch (error) {
    headers.set("Cache-Control", "no-store");
    return new Response(method === "HEAD" ? null : error instanceof Error ? error.message : "无法导出 v2rayN 订阅", {
      status: 422,
      headers,
    });
  }
}
