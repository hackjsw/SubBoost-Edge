export const STORED_CONFIG_CACHE_TTL_MS = 30_000;
const STORED_CONFIG_CACHE_MAX_ENTRIES = 32;
export const STORED_CONFIG_CACHE_MAX_BODY_BYTES = 512 * 1024;

type ResponseSnapshot = {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: string;
  expiresAt?: number;
};

const entries = new Map<string, ResponseSnapshot>();
const generations = new Map<string, number>();
// A reset must invalidate work that was already awaiting an upstream read.
// Keep this separate from per-token generations so clearing the maps cannot
// accidentally make an old generation look current again.
let cacheEpoch = 0;

type LoadResult =
  | { kind: "snapshot"; snapshot: ResponseSnapshot }
  | { kind: "response"; response: Response };

type InflightLoad = {
  generation: string;
  promise: Promise<LoadResult>;
  waiters: number;
};

const inflight = new Map<string, InflightLoad>();

export function storedConfigCacheKey(token: string, method: "GET" | "HEAD", raw: boolean): string {
  return `${token}:${method}:${raw ? "raw" : "public"}`;
}

export function invalidateStoredConfigCache(token: string): void {
  const prefix = `${token}:`;
  generations.set(token, (generations.get(token) ?? 0) + 1);
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
  for (const key of [...inflight.keys()]) {
    if (key.startsWith(prefix)) inflight.delete(key);
  }
}

export function resetStoredConfigCache(): void {
  entries.clear();
  inflight.clear();
  generations.clear();
  cacheEpoch += 1;
}

function responseFromSnapshot(snapshot: ResponseSnapshot, method: "GET" | "HEAD"): Response {
  return new Response(method === "HEAD" ? null : snapshot.body, {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: snapshot.headers,
  });
}

function remember(key: string, snapshot: ResponseSnapshot, now: number): void {
  if (entries.size >= STORED_CONFIG_CACHE_MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest) entries.delete(oldest);
  }
  entries.set(key, { ...snapshot, expiresAt: now + STORED_CONFIG_CACHE_TTL_MS });
}

function cacheToken(key: string): string {
  const separator = key.indexOf(":");
  return separator === -1 ? key : key.slice(0, separator);
}

function currentGeneration(key: string): string {
  return `${cacheEpoch}:${generations.get(cacheToken(key)) ?? 0}`;
}

function contentLength(response: Response): number | null {
  const value = response.headers.get("content-length");
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function responseFromLoadResult(
  result: LoadResult,
  method: "GET" | "HEAD",
  active: InflightLoad
): Response {
  if (result.kind === "snapshot") return responseFromSnapshot(result.snapshot, method);
  const lastWaiter = active.waiters === 1;
  if (method === "HEAD") {
    if (lastWaiter) void result.response.body?.cancel();
    return new Response(null, {
      status: result.response.status,
      statusText: result.response.statusText,
      headers: result.response.headers,
    });
  }
  return lastWaiter ? result.response : result.response.clone();
}

function releaseWaiter(key: string, active: InflightLoad): void {
  active.waiters = Math.max(0, active.waiters - 1);
  if (active.waiters === 0 && inflight.get(key) === active) inflight.delete(key);
}

async function snapshotWithinLimit(
  response: Response,
  method: "GET" | "HEAD"
): Promise<ResponseSnapshot | null> {
  if (method === "HEAD" || response.body === null) {
    return {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
      body: "",
    };
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.clone().body?.getReader();
  } catch {
    return null;
  }
  if (!reader) return null;
  const decoder = new TextDecoder();
  let body = "";
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        body += decoder.decode();
        return {
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers.entries()],
          body,
        };
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > STORED_CONFIG_CACHE_MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    try {
      await reader.cancel();
    } catch {}
    return null;
  }
}

export async function loadStoredConfigResponse(
  key: string,
  options: { method: "GET" | "HEAD"; now?: number },
  loader: () => Promise<Response>
): Promise<Response> {
  const now = options.now ?? Date.now();
  const generation = currentGeneration(key);
  const hit = entries.get(key);
  if (hit && (hit.expiresAt ?? 0) > now) {
    return responseFromSnapshot(hit, options.method);
  }

  const existing = inflight.get(key);
  if (existing?.generation === generation) {
    existing.waiters += 1;
    try {
      const result = await existing.promise;
      return responseFromLoadResult(result, options.method, existing);
    } finally {
      releaseWaiter(key, existing);
    }
  }

  const pending = (async (): Promise<LoadResult> => {
    const response = await loader();
    const size = contentLength(response);
    if (
      !response.ok ||
      (size !== null && size > STORED_CONFIG_CACHE_MAX_BODY_BYTES)
    ) {
      return { kind: "response", response };
    }
    const snapshot = await snapshotWithinLimit(response, options.method);
    if (!snapshot) return { kind: "response", response };
    await response.body?.cancel();
    if (currentGeneration(key) === generation) remember(key, snapshot, now);
    return { kind: "snapshot", snapshot };
  })();

  const active = { generation, promise: pending, waiters: 1 };
  inflight.set(key, active);
  try {
    const result = await pending;
    return responseFromLoadResult(result, options.method, active);
  } finally {
    releaseWaiter(key, active);
  }
}
