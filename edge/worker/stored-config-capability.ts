import { byteLength } from "./encoding";
import { methodNotAllowed } from "./http";
import type { WorkerEnv } from "./types";

export const STORED_CONFIG_CAPABILITY_TTL_SECONDS = 300;
const CAPABILITY_KEY_PREFIX = "edge-config-capability:v1:";
const CAPABILITY_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const CAPABILITY_RECORD_VERSION = 1;

type CapabilityRecord = {
  version: typeof CAPABILITY_RECORD_VERSION;
  yaml: string;
  expiresAt: number;
};

function capabilityNotFound(method: string): Response {
  return new Response(method === "HEAD" ? null : "Subscription not found", {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function createStoredConfigCapability(
  env: WorkerEnv,
  requestUrl: string,
  yaml: string
): Promise<string> {
  if (!env.SUB_KV) throw new Error("KV is not configured");
  const token = crypto.randomUUID().replaceAll("-", "");
  const value: CapabilityRecord = {
    version: CAPABILITY_RECORD_VERSION,
    yaml,
    expiresAt: Date.now() + STORED_CONFIG_CAPABILITY_TTL_SECONDS * 1000,
  };
  await env.SUB_KV.put(`${CAPABILITY_KEY_PREFIX}${token}`, JSON.stringify(value), {
    expirationTtl: STORED_CONFIG_CAPABILITY_TTL_SECONDS,
  });
  return new URL(`/config-cap/${token}`, requestUrl).toString();
}

export async function handleStoredConfigCapability(
  request: Request,
  env: WorkerEnv
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed(["GET", "HEAD"]);
  }
  if (!env.SUB_KV) return capabilityNotFound(request.method);
  const pathname = new URL(request.url).pathname;
  const token = pathname.startsWith("/config-cap/") ? pathname.slice("/config-cap/".length) : "";
  if (!CAPABILITY_TOKEN_PATTERN.test(token) || pathname !== `/config-cap/${token}`) {
    return capabilityNotFound(request.method);
  }

  let stored: string | null;
  try {
    stored = await env.SUB_KV.get(`${CAPABILITY_KEY_PREFIX}${token}`);
  } catch {
    return capabilityNotFound(request.method);
  }
  if (stored === null) return capabilityNotFound(request.method);

  let record: CapabilityRecord;
  try {
    const parsed = JSON.parse(stored) as Partial<CapabilityRecord>;
    if (
      parsed.version !== CAPABILITY_RECORD_VERSION ||
      typeof parsed.yaml !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      !Number.isFinite(parsed.expiresAt) ||
      parsed.expiresAt <= Date.now()
    ) {
      return capabilityNotFound(request.method);
    }
    record = parsed as CapabilityRecord;
  } catch {
    return capabilityNotFound(request.method);
  }

  return new Response(request.method === "HEAD" ? null : record.yaml, {
    headers: {
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
      "Referrer-Policy": "no-referrer",
      "Content-Length": String(byteLength(record.yaml)),
      "Content-Type": "text/yaml;charset=UTF-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
