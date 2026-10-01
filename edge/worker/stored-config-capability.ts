import { sessionSecret } from "./auth";
import { byteLength } from "./encoding";
import { methodNotAllowed } from "./http";
import type { WorkerEnv } from "./types";

// Capabilities are sealed, self-contained URLs: no KV write per conversion, no
// cross-colo propagation delay, and the stored token never leaves the Worker.
// Expiry is bucketed so one revision keeps the same URL for a whole window,
// which lets the converter's own cache hit across client polls.
export const STORED_CONFIG_CAPABILITY_TTL_SECONDS = 300;
const CAPABILITY_PATH_PREFIX = "/config-cap/";
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{40,400}$/;
const CAPABILITY_CONTEXT = "edgesub:config-cap:v2";
const IV_BYTES = 12;
const TTL_MS = STORED_CONFIG_CAPABILITY_TTL_SECONDS * 1000;

export type StoredConfigCapability = { token: string; revision: string };

const keyCache = new Map<string, Promise<{ mac: CryptoKey; aes: CryptoKey }>>();

function capabilityKeys(secret: string): Promise<{ mac: CryptoKey; aes: CryptoKey }> {
  let keys = keyCache.get(secret);
  if (!keys) {
    keys = (async () => {
      const mac = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const raw = await crypto.subtle.sign("HMAC", mac, new TextEncoder().encode(`${CAPABILITY_CONTEXT}:aes`));
      const aes = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
      return { mac, aes };
    })();
    keyCache.set(secret, keys);
  }
  return keys;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    return Uint8Array.from(atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4)), char => char.charCodeAt(0));
  } catch {
    return null;
  }
}

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
  capability: StoredConfigCapability,
  now = Date.now()
): Promise<string> {
  const secret = sessionSecret(env);
  if (!secret) throw new Error("Session secret is not configured");
  const { mac, aes } = await capabilityKeys(secret);
  const expiresAt = (Math.floor(now / TTL_MS) + 2) * TTL_MS;
  const payload = new TextEncoder().encode(`${capability.token}.${expiresAt}.${capability.revision}`);
  // Deterministic IV: identical inputs must produce the identical URL.
  const ivSource = await crypto.subtle.sign(
    "HMAC",
    mac,
    new TextEncoder().encode(`${CAPABILITY_CONTEXT}:iv:${capability.token}.${expiresAt}.${capability.revision}`)
  );
  const iv = new Uint8Array(ivSource).slice(0, IV_BYTES);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, payload));
  const bytes = new Uint8Array(iv.length + sealed.length);
  bytes.set(iv);
  bytes.set(sealed, iv.length);
  return new URL(`${CAPABILITY_PATH_PREFIX}${toBase64Url(bytes)}`, requestUrl).toString();
}

export async function openStoredConfigCapability(
  env: WorkerEnv,
  pathname: string,
  now = Date.now()
): Promise<StoredConfigCapability | null> {
  const sealed = pathname.startsWith(CAPABILITY_PATH_PREFIX) ? pathname.slice(CAPABILITY_PATH_PREFIX.length) : "";
  const secret = sessionSecret(env);
  if (!secret || !CAPABILITY_PATTERN.test(sealed)) return null;
  const bytes = fromBase64Url(sealed);
  if (!bytes || bytes.length <= IV_BYTES) return null;

  let payload: string;
  try {
    const { aes } = await capabilityKeys(secret);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, IV_BYTES) },
      aes,
      bytes.slice(IV_BYTES)
    );
    payload = new TextDecoder().decode(plain);
  } catch {
    return null;
  }

  const [token, expires, revision, extra] = payload.split(".");
  const expiresAt = Number(expires);
  if (extra !== undefined || !token || !revision || !Number.isSafeInteger(expiresAt)) return null;
  if (expiresAt <= now || expiresAt - now > 2 * TTL_MS) return null;
  return { token, revision };
}

export async function handleStoredConfigCapability(
  request: Request,
  env: WorkerEnv,
  resolve: (capability: StoredConfigCapability) => Promise<string | null>
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed(["GET", "HEAD"]);
  }
  const capability = await openStoredConfigCapability(env, new URL(request.url).pathname);
  if (!capability) return capabilityNotFound(request.method);

  let yaml: string | null;
  try {
    yaml = await resolve(capability);
  } catch {
    return capabilityNotFound(request.method);
  }
  if (yaml === null) return capabilityNotFound(request.method);

  return new Response(request.method === "HEAD" ? null : yaml, {
    headers: {
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
      "Referrer-Policy": "no-referrer",
      "Content-Length": String(byteLength(yaml)),
      "Content-Type": "text/yaml;charset=UTF-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
