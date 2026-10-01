import { json, methodNotAllowed, readJsonBody } from "./http";
import type { WorkerEnv } from "./types";

const SESSION_COOKIE = "subboost_edge_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOGIN_ATTEMPT_TTL_SECONDS = 15 * 60;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_ATTEMPT_PREFIX = "edge-auth-attempt:";

function bytesToBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    while (normalized.length % 4) normalized += "=";
    return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([sha256(left), sha256(right)]);
  let mismatch = 0;
  for (let index = 0; index < leftHash.length; index += 1) {
    mismatch |= leftHash[index] ^ rightHash[index];
  }
  return mismatch === 0;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export function sessionSecret(env: WorkerEnv): string {
  return env.EDGE_SESSION_SECRET?.trim() || env.EDGE_ADMIN_PASSWORD?.trim() || "";
}

async function createSessionToken(env: WorkerEnv, now = new Date()): Promise<{ token: string; expiresAt: string }> {
  const expiresAtSeconds = Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS;
  const message = `v1.${expiresAtSeconds}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await importHmacKey(sessionSecret(env)), new TextEncoder().encode(message))
  );
  return {
    token: `${message}.${bytesToBase64Url(signature)}`,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  };
}

function readCookie(request: Request, name: string): string {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return "";
}

export function isAuthConfigured(env: WorkerEnv): boolean {
  return Boolean(env.EDGE_ADMIN_PASSWORD?.trim() && sessionSecret(env));
}

export async function isAuthenticated(request: Request, env: WorkerEnv, now = new Date()): Promise<boolean> {
  if (!isAuthConfigured(env)) return false;
  const parts = readCookie(request, SESSION_COOKIE).split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;

  const expiresAtSeconds = Number(parts[1]);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (
    !Number.isInteger(expiresAtSeconds) ||
    expiresAtSeconds <= nowSeconds ||
    expiresAtSeconds > nowSeconds + SESSION_TTL_SECONDS
  ) {
    return false;
  }

  const signature = base64UrlToBytes(parts[2]);
  if (!signature) return false;
  try {
    return crypto.subtle.verify(
      "HMAC",
      await importHmacKey(sessionSecret(env)),
      signature,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
  } catch {
    return false;
  }
}

async function loginAttemptKey(request: Request): Promise<string> {
  const address = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
  const digest = await sha256(address.split(",", 1)[0].trim());
  return `${LOGIN_ATTEMPT_PREFIX}${Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function readLoginAttempts(request: Request, env: WorkerEnv): Promise<{ key: string; count: number }> {
  const key = await loginAttemptKey(request);
  if (!env.SUB_KV) return { key, count: 0 };
  try {
    const stored = await env.SUB_KV.get(key);
    if (!stored) return { key, count: 0 };
    const value = JSON.parse(stored) as { count?: unknown };
    return { key, count: typeof value.count === "number" && Number.isFinite(value.count) ? value.count : 0 };
  } catch {
    return { key, count: 0 };
  }
}

export async function handleAuthLogin(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  if (!isAuthConfigured(env)) return json({ error: "管理员密码尚未配置" }, 503);

  const attempts = await readLoginAttempts(request, env);
  if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
    return json({ error: "登录尝试过多，请稍后再试" }, 429, { "Retry-After": String(LOGIN_ATTEMPT_TTL_SECONDS) });
  }

  const body = await readJsonBody(request);
  const password = typeof body?.password === "string" ? body.password : "";
  const valid = await constantTimeEqual(password, env.EDGE_ADMIN_PASSWORD?.trim() || "");
  if (!valid) {
    if (env.SUB_KV) {
      await env.SUB_KV.put(attempts.key, JSON.stringify({ count: attempts.count + 1 }), {
        expirationTtl: LOGIN_ATTEMPT_TTL_SECONDS,
      });
    }
    return json({ error: "密码错误" }, 401);
  }

  if (env.SUB_KV) await env.SUB_KV.delete(attempts.key);
  const session = await createSessionToken(env);
  return json(
    { ok: true, expiresAt: session.expiresAt },
    200,
    {
      "Set-Cookie": `${SESSION_COOKIE}=${session.token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
    }
  );
}

export function handleAuthLogout(request: Request): Response {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  return json(
    { ok: true },
    200,
    { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` }
  );
}

export function unauthorizedResponse(): Response {
  return json({ error: "请先登录" }, 401);
}
