// Converted (remote-profile) configs are slow, CPU-heavy to merge, and depend on
// third-party converters. Keep the last good result per subscription revision
// in the colo cache: serve it while fresh, retry the converter when older, and
// fall back to it when every converter fails. The Cache API only works on
// custom domains; on workers.dev every lookup simply misses.
export const CONVERTED_FRESH_MS = 30 * 60 * 1000;
const CONVERTED_RETAIN_SECONDS = 7 * 24 * 60 * 60;
const CONVERTED_AT_HEADER = "X-EdgeSub-Converted-At";
const CACHE_PATH_PREFIX = "/__edgesub/converted/";

type CacheLike = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

function edgeCache(): CacheLike | undefined {
  if (typeof caches === "undefined") return undefined;
  return (caches as unknown as { default?: CacheLike }).default;
}

export function convertedConfigCacheKey(requestUrl: string, token: string, revision: string): Request {
  // Only this Worker can read these entries: requests to the custom domain run
  // the Worker, never a direct cache lookup.
  return new Request(new URL(`${CACHE_PATH_PREFIX}${token}/${revision}`, requestUrl).toString());
}

export async function readConvertedConfig(
  key: Request,
  now = Date.now()
): Promise<{ response: Response; fresh: boolean } | null> {
  const cache = edgeCache();
  if (!cache) return null;
  try {
    const response = await cache.match(key);
    if (!response) return null;
    const convertedAt = Number(response.headers.get(CONVERTED_AT_HEADER));
    return { response, fresh: Number.isFinite(convertedAt) && now - convertedAt < CONVERTED_FRESH_MS };
  } catch {
    return null;
  }
}

export async function storeConvertedConfig(key: Request, body: string, headers: Headers, now = Date.now()): Promise<void> {
  const cache = edgeCache();
  if (!cache) return;
  const stored = new Headers(headers);
  stored.delete("Set-Cookie");
  stored.set("Cache-Control", `max-age=${CONVERTED_RETAIN_SECONDS}`);
  stored.set(CONVERTED_AT_HEADER, String(now));
  try {
    await cache.put(key, new Response(body, { status: 200, headers: stored }));
  } catch {
    // Caching is an optimisation; the response itself already succeeded.
  }
}

export function serveConvertedConfig(cached: Response, method: "GET" | "HEAD", state: "hit" | "stale"): Response {
  const headers = new Headers(cached.headers);
  const convertedAt = Number(headers.get(CONVERTED_AT_HEADER));
  headers.delete(CONVERTED_AT_HEADER);
  headers.delete("Age");
  headers.delete("CF-Cache-Status");
  headers.set("Cache-Control", "no-store");
  headers.set("X-SubBoost-Converter-Cache", state);
  if (Number.isFinite(convertedAt)) headers.set("X-SubBoost-Converted-At", new Date(convertedAt).toISOString());
  if (method === "HEAD") {
    void cached.body?.cancel();
    return new Response(null, { status: 200, headers });
  }
  return new Response(cached.body, { status: 200, headers });
}
