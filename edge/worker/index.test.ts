import { beforeEach, describe, expect, it, vi } from "vitest";
import { getClashConversionProfile } from "@subboost/core/subscription/clash-conversion-profiles";
import {
  KV_TTL,
  MAX_STORED_SUBSCRIPTION_BYTES,
  MAX_STORED_YAML_BYTES,
  MAX_REMOTE_REQUESTS_PER_REFRESH,
  MAX_TEST_NODES,
} from "./constants";
import { runScheduledSubscriptionUpdates } from "./edge-api";
import worker, { handleRequest } from "./index";
import {
  getNextRuleCatalogRunAt,
  RULE_CATALOG_CRON,
  RULE_INDEX_CACHE_KEY,
} from "./rules-api";
import { resetStoredConfigCache } from "./stored-config-cache";
import { STORED_CONFIG_CAPABILITY_TTL_SECONDS } from "./stored-config-capability";
import type { ExecutionContextLike, KVNamespaceLike, WorkerEnv } from "./types";

class MemoryKv implements KVNamespaceLike {
  readonly values = new Map<string, string>();
  readonly metadata = new Map<string, unknown>();
  readonly reads: string[] = [];
  readonly writes: Array<{ key: string; expirationTtl?: number; metadata?: unknown }> = [];

  async get(key: string): Promise<string | null> {
    this.reads.push(key);
    return this.values.get(key) ?? null;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: unknown }
  ): Promise<void> {
    this.values.set(key, value);
    if (options?.metadata === undefined) this.metadata.delete(key);
    else this.metadata.set(key, options.metadata);
    this.writes.push({
      key,
      ...(options?.expirationTtl !== undefined ? { expirationTtl: options.expirationTtl } : {}),
      ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
    });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
    this.metadata.delete(key);
  }

  async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
    const names = Array.from(this.values.keys())
      .filter((name) => !options.prefix || name.startsWith(options.prefix))
      .sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const limit = options.limit ?? 1000;
    const keys = names.slice(start, start + limit).map((name) => ({
      name,
      ...(this.metadata.has(name) ? { metadata: this.metadata.get(name) } : {}),
    }));
    const next = start + keys.length;
    return {
      keys,
      list_complete: next >= names.length,
      ...(next < names.length ? { cursor: String(next) } : {}),
    };
  }
}

function createContext(): ExecutionContextLike & { promises: Promise<unknown>[] } {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    waitUntil(promise) {
      promises.push(promise);
    },
  };
}

const TEST_PASSWORD = "test-admin-password";
const TEST_SESSION_SECRET = "test-session-secret-with-enough-entropy";

function createEnv(kv?: MemoryKv, extra: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    ...(kv ? { SUB_KV: kv } : {}),
    EDGE_ADMIN_PASSWORD: TEST_PASSWORD,
    EDGE_SESSION_SECRET: TEST_SESSION_SECRET,
    ...extra,
  };
}

async function login(env: WorkerEnv): Promise<string> {
  const response = await handleRequest(
    new Request("https://edge.test/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.10" },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    }),
    env
  );
  if (!response.ok) throw new Error(`Test login failed with status ${response.status}`);
  return (response.headers.get("set-cookie") || "").split(";", 1)[0];
}

function authenticatedRequest(url: string, cookie: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Cookie", cookie);
  return new Request(url, { ...init, headers });
}

function createRuleTreeFetch(
  paths = ["geosite/google.mrs", "geoip/cn.mrs"],
  lists: Record<string, string> = {}
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/git/trees/meta")) {
      return new Response(
        JSON.stringify({ sha: "meta", tree: [{ path: "geo", type: "tree", sha: "geo-sha" }] }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.includes("/git/trees/geo-sha")) {
      return new Response(
        JSON.stringify({
          sha: "geo-sha",
          tree: paths.map((path) => ({ path, type: "blob", sha: `sha-${path}` })),
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    for (const [suffix, body] of Object.entries(lists)) {
      if (url.endsWith(suffix)) return new Response(body, { headers: { "Content-Type": "text/plain" } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("EdgeSub worker", () => {
  beforeEach(() => {
    resetStoredConfigCache();
  });
  it("redirects anonymous pages to login and serves assets after authentication", async () => {
    const env = createEnv(undefined, {
      ASSETS: {
        async fetch() {
          return new Response("edge-ui", { headers: { "Content-Type": "text/html" } });
        },
      },
    });

    const anonymousResponse = await handleRequest(new Request("https://edge.test/"), env);
    expect(anonymousResponse.status).toBe(302);
    expect(anonymousResponse.headers.get("location")).toBe("https://edge.test/login?next=%2F");

    const loginPageResponse = await handleRequest(new Request("https://edge.test/login"), env);
    expect(loginPageResponse.status).toBe(200);

    const logoResponse = await handleRequest(new Request("https://edge.test/edgesub-mark.svg"), env);
    expect(logoResponse.status).toBe(200);

    const cookie = await login(env);
    const response = await handleRequest(authenticatedRequest("https://edge.test/", cookie), env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("edge-ui");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects wrong passwords and issues a signed HttpOnly session", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const anonymous = await handleRequest(new Request("https://edge.test/api/subscriptions"), env);
    expect(anonymous.status).toBe(401);

    const failed = await handleRequest(
      new Request("https://edge.test/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.20" },
        body: JSON.stringify({ password: "wrong" }),
      }),
      env
    );
    expect(failed.status).toBe(401);
    expect(kv.writes.at(-1)?.expirationTtl).toBe(900);

    const cookie = await login(env);
    expect(cookie).toMatch(/^subboost_edge_session=v1\./);
    const me = await handleRequest(authenticatedRequest("https://edge.test/api/auth/me", cookie), env);
    const meData = (await me.json()) as { user?: { isAdmin?: boolean } };
    expect(me.status).toBe(200);
    expect(meData.user?.isAdmin).toBe(true);
  });

  it("creates legacy short links and refreshes their rolling TTL", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const source = "vless://00000000-0000-4000-8000-000000000000@example.com:443?security=tls#HK";
    const createResponse = await handleRequest(
      authenticatedRequest("https://edge.test/shorten", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, dedup: true }),
      }),
      env
    );
    const created = (await createResponse.json()) as { id: string; shortUrl: string };

    expect(createResponse.status).toBe(200);
    expect(created.id).toMatch(/^[a-f0-9]{12}$/);
    expect(kv.writes[0]).toEqual({ key: created.id, expirationTtl: KV_TTL });

    const ctx = createContext();
    const readResponse = await handleRequest(
      new Request(`${created.shortUrl}&raw=true`),
      { SUB_KV: kv },
      ctx
    );
    const content = await readResponse.text();

    expect(readResponse.status).toBe(200);
    expect(content).toContain("www.shopify.com");
    expect(content).toContain("example.com");
    await Promise.all(ctx.promises);
    expect(kv.writes.at(-1)).toEqual({ key: created.id, expirationTtl: KV_TTL });
  });

  it("stores generated YAML persistently without refreshing a TTL on access", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const createResponse = await handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "My Edge Config", yaml: "proxies: []\nrules: []\n" }),
      }),
      env
    );
    const created = (await createResponse.json()) as {
      subscription: { subscriptionUrl: string; token: string; conversionProfileId: string };
    };

    expect(created.subscription.token).toMatch(/^[a-f0-9]{20}$/);
    expect(created.subscription.conversionProfileId).toBe("native");
    const configResponse = await handleRequest(
      new Request(created.subscription.subscriptionUrl),
      { SUB_KV: kv }
    );

    expect(configResponse.status).toBe(200);
    expect(configResponse.headers.get("content-type")).toContain("text/yaml");
    expect(configResponse.headers.get("x-subboost-storage")).toBe("persistent-kv");
    expect(await configResponse.text()).toContain("proxies: []");
    expect(kv.writes).toHaveLength(1);
    expect(kv.writes[0]?.expirationTtl).toBeUndefined();
  });

  it("stores YAML above the previous 2 MiB limit through create and update", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const previousLimit = 2 * 1024 * 1024;
    const yaml = `payload: ${"a".repeat(previousLimit)}\n`;

    expect(new TextEncoder().encode(yaml).byteLength).toBeGreaterThan(previousLimit);
    expect(new TextEncoder().encode(yaml).byteLength).toBeLessThanOrEqual(MAX_STORED_YAML_BYTES);

    const createResponse = await handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Large Edge Config", yaml }),
      }),
      env
    );
    const created = (await createResponse.json()) as { subscription: { token: string } };
    const key = `edge-config:${created.subscription.token}`;

    expect(createResponse.status).toBe(200);
    expect(JSON.parse(kv.values.get(key) || "{}").yaml).toBe(yaml);

    const updatedYaml = `payload: ${"b".repeat(previousLimit)}\n`;
    const updateResponse = await handleRequest(
      authenticatedRequest(`https://edge.test/api/subscriptions/${created.subscription.token}`, cookie, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated Large Edge Config", yaml: updatedYaml }),
      }),
      env
    );

    expect(updateResponse.status).toBe(200);
    expect(JSON.parse(kv.values.get(key) || "{}").yaml).toBe(updatedYaml);
  });

  it("rejects YAML above 8 MiB without writing create or update data to KV", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const yaml = `payload: ${"a".repeat(MAX_STORED_YAML_BYTES)}\n`;

    expect(new TextEncoder().encode(yaml).byteLength).toBeGreaterThan(MAX_STORED_YAML_BYTES);

    const createResponse = await handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Oversized Edge Config", yaml }),
      }),
      env
    );

    expect(createResponse.status).toBe(413);
    await expect(createResponse.json()).resolves.toEqual({ error: "配置文件过大" });
    expect(Array.from(kv.values.keys()).filter((key) => key.startsWith("edge-config:"))).toHaveLength(0);

    const baselineResponse = await handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Baseline", yaml: "proxies: []\n" }),
      }),
      env
    );
    const baseline = (await baselineResponse.json()) as { subscription: { token: string } };
    const key = `edge-config:${baseline.subscription.token}`;
    const storedBeforeUpdate = kv.values.get(key);
    kv.writes.length = 0;

    const updateResponse = await handleRequest(
      authenticatedRequest(`https://edge.test/api/subscriptions/${baseline.subscription.token}`, cookie, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Oversized Update", yaml }),
      }),
      env
    );

    expect(updateResponse.status).toBe(413);
    await expect(updateResponse.json()).resolves.toEqual({ error: "配置文件过大" });
    expect(kv.values.get(key)).toBe(storedBeforeUpdate);
    expect(kv.writes).toHaveLength(0);
  });

  it("keeps the 20 MiB serialized subscription record guard", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const response = await handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Oversized KV Record",
          yaml: "proxies: []\n",
          config: { payload: "a".repeat(MAX_STORED_SUBSCRIPTION_BYTES) },
        }),
      }),
      env
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "订阅数据过大，无法保存到 KV" });
    expect(Array.from(kv.values.keys()).filter((key) => key.startsWith("edge-config:"))).toHaveLength(0);
    expect(kv.writes).toHaveLength(0);
  });

  it("converts allowlisted stored profiles while raw reads remain local", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv, { SUBCONVERTER_BACKEND: "https://converter.test/sub" });
    const cookie = await login(env);
    const createResponse = await handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "ACL4SSR Mini",
          yaml: "proxies: []\nrules:\n  - MATCH,DIRECT\n",
          conversionProfileId: "acl4ssr-online-mini",
        }),
      }),
      env
    );
    const created = (await createResponse.json()) as {
      subscription: { subscriptionUrl: string; token: string; conversionProfileId: string };
    };
    expect(created.subscription.conversionProfileId).toBe("acl4ssr-online-mini");

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("proxies: [{name: Probe, type: trojan, server: example.com, port: 443, password: fake}]\nproxy-groups: [{name: Proxy, type: select, proxies: [Probe]}]\nrules:\n  - MATCH,Proxy\n", {
        headers: { "Content-Type": "text/plain", "Content-Length": "42" },
      })
    );
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const converted = await handleRequest(new Request(created.subscription.subscriptionUrl), env);
      expect(converted.status).toBe(200);
      expect(await converted.text()).toContain("MATCH,Proxy");
      expect(converted.headers.get("content-type")).toContain("text/yaml");
      expect(converted.headers.get("content-length")).toBeNull();
      expect(converted.headers.get("x-subboost-storage")).toBe("persistent-kv");

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const converterUrl = new URL(String(fetchImpl.mock.calls[0]?.[0]));
      expect(converterUrl.searchParams.get("target")).toBe("clash");
      const capabilityUrl = converterUrl.searchParams.get("url");
      expect(capabilityUrl).toMatch(/^https:\/\/edge\.test\/config-cap\/[a-f0-9]{32}$/);
      expect(capabilityUrl).not.toContain(created.subscription.token);
      expect(kv.writes.at(-1)).toMatchObject({
        key: expect.stringMatching(/^edge-config-capability:v1:[a-f0-9]{32}$/),
        expirationTtl: STORED_CONFIG_CAPABILITY_TTL_SECONDS,
      });
      const capabilityResponse = await handleRequest(new Request(capabilityUrl || ""), env);
      expect(capabilityResponse.status).toBe(200);
      expect(await capabilityResponse.text()).toContain("MATCH,DIRECT");
      expect(converterUrl.searchParams.get("config")).toBe(
        getClashConversionProfile("acl4ssr-online-mini").configUrl
      );
      expect(converterUrl.searchParams.get("emoji")).toBe("true");
      expect(converterUrl.searchParams.get("udp")).toBe("true");
      expect(converterUrl.searchParams.get("list")).toBe("false");

      fetchImpl.mockClear();
      const head = await handleRequest(
        new Request(created.subscription.subscriptionUrl, { method: "HEAD" }),
        env
      );
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });

      fetchImpl.mockClear();
      const raw = await handleRequest(
        new Request(`${created.subscription.subscriptionUrl}?raw=1`),
        env
      );
      expect(raw.status).toBe(200);
      expect(await raw.text()).toContain("MATCH,DIRECT");
      expect(fetchImpl).not.toHaveBeenCalled();

      fetchImpl.mockClear();
      const convertedAgain = await handleRequest(new Request(created.subscription.subscriptionUrl), env);
      expect(convertedAgain.status).toBe(200);
      expect(await convertedAgain.text()).toContain("MATCH,Proxy");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("requires an explicit converter backend for stored remote profiles", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const createResponse = await handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Remote Profile",
          yaml: "proxies: []\n",
          conversionProfileId: "acl4ssr-online-mini",
        }),
      }),
      env
    );
    const created = (await createResponse.json()) as { subscription: { subscriptionUrl: string } };
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const response = await handleRequest(new Request(created.subscription.subscriptionUrl), env);
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("backend is not configured");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect([...kv.values.keys()].some((key) => key.startsWith("edge-config-capability:v1:"))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reuses stored config GET responses until a write and ignores public cache bypasses", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const createResponse = await handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Cached", yaml: "proxies: []\nrules:\n  - MATCH,DIRECT\n" }),
      }),
      env
    );
    const created = (await createResponse.json()) as { subscription: { token: string; subscriptionUrl: string } };
    const configUrl = created.subscription.subscriptionUrl;
    const configKey = `edge-config:${created.subscription.token}`;

    const first = await handleRequest(new Request(configUrl), env);
    expect(await first.text()).toContain("MATCH,DIRECT");
    const readsAfterFirst = kv.reads.filter((key) => key === configKey).length;

    const second = await handleRequest(new Request(configUrl), env);
    expect(await second.text()).toContain("MATCH,DIRECT");
    expect(kv.reads.filter((key) => key === configKey)).toHaveLength(readsAfterFirst);

    const forced = await handleRequest(new Request(`${configUrl}?force=1`), env);
    expect(await forced.text()).toContain("MATCH,DIRECT");
    expect(kv.reads.filter((key) => key === configKey)).toHaveLength(readsAfterFirst);

    const updateResponse = await handleRequest(
      authenticatedRequest(`https://edge.test/api/subscriptions/${created.subscription.token}`, cookie, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Cached", yaml: "proxies: []\nrules:\n  - MATCH,PROXY\n" }),
      }),
      env
    );
    expect(updateResponse.status).toBe(200);

    const afterUpdate = await handleRequest(new Request(configUrl), env);
    expect(await afterUpdate.text()).toContain("MATCH,PROXY");
  });

  it("rejects unknown profile writes and keeps the public URL stable across updates", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const invalidResponse = await handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Invalid",
          yaml: "proxies: []\n",
          conversionProfileId: "https://example.com/config.ini",
        }),
      }),
      env
    );
    expect(invalidResponse.status).toBe(400);
    expect(Array.from(kv.values.keys()).filter((key) => key.startsWith("edge-config:"))).toHaveLength(0);

    const createResponse = await handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Stable",
          yaml: "proxies: []\n",
          conversionProfileId: "acl4ssr-online",
        }),
      }),
      env
    );
    const created = (await createResponse.json()) as {
      subscription: { subscriptionUrl: string; token: string; conversionProfileId: string };
    };
    const recordUrl = `https://edge.test/api/subscriptions/${created.subscription.token}`;

    const preservedResponse = await handleRequest(
      authenticatedRequest(recordUrl, cookie, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Preserved", yaml: "proxies: []\n" }),
      }),
      env
    );
    const preserved = (await preservedResponse.json()) as {
      subscription: { subscriptionUrl: string; conversionProfileId: string };
    };
    expect(preserved.subscription.subscriptionUrl).toBe(created.subscription.subscriptionUrl);
    expect(preserved.subscription.conversionProfileId).toBe("acl4ssr-online");

    const changedResponse = await handleRequest(
      authenticatedRequest(recordUrl, cookie, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Changed",
          yaml: "proxies: []\n",
          conversionProfileId: "acl4ssr-online-full",
        }),
      }),
      env
    );
    const changed = (await changedResponse.json()) as {
      subscription: { subscriptionUrl: string; conversionProfileId: string };
    };
    expect(changed.subscription.subscriptionUrl).toBe(created.subscription.subscriptionUrl);
    expect(changed.subscription.conversionProfileId).toBe("acl4ssr-online-full");
  });

  it("uses allowlisted profiles on the legacy clash endpoint", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("proxies: [{name: Probe, type: trojan, server: example.com, port: 443, password: fake}]\nproxy-groups: [{name: Proxy, type: select, proxies: [Probe]}]\nrules: [MATCH,Proxy]\n")
    );
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const clashUrl = new URL("https://edge.test/clash");
      clashUrl.searchParams.set(
        "source",
        "vless://00000000-0000-4000-8000-000000000000@example.com:443?security=tls#HK"
      );
      clashUrl.searchParams.set("profile", "acl4ssr-online-no-auto");
      const response = await handleRequest(authenticatedRequest(clashUrl.toString(), cookie), env);
      expect(response.status).toBe(200);
      const converterUrl = new URL(String(fetchImpl.mock.calls[0]?.[0]));
      expect(converterUrl.searchParams.get("config")).toBe(
        getClashConversionProfile("acl4ssr-online-no-auto").configUrl
      );

      fetchImpl.mockClear();
      clashUrl.searchParams.set("profile", "native");
      const invalid = await handleRequest(authenticatedRequest(clashUrl.toString(), cookie), env);
      expect(invalid.status).toBe(400);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("requires an explicit converter backend for legacy short-link clash requests", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const token = "short-link";
    kv.values.set(
      token,
      JSON.stringify({
        source: "vless://00000000-0000-4000-8000-000000000000@example.com:443?security=tls#HK",
      })
    );
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const response = await handleRequest(new Request(`https://edge.test/clash?id=${token}`), env);
      expect(response.status).toBe(503);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lists, loads, updates, refreshes, and deletes authenticated KV records", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const source =
      "vless://00000000-0000-4000-8000-000000000000@example.com:443?encryption=none&security=tls#Managed";
    const createResponse = await handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Managed",
          yaml: "proxies: []\nrules: []\n",
          autoUpdateInterval: 3600,
          nodes: [],
          urls: [],
          config: { template: "minimal", sources: [{ id: "source-1", type: "nodes", content: source }] },
        }),
      }),
      env
    );
    const created = (await createResponse.json()) as { subscription: { token: string } };
    const recordUrl = `https://edge.test/api/subscriptions/${created.subscription.token}`;

    const listResponse = await handleRequest(authenticatedRequest("https://edge.test/api/subscriptions", cookie), env);
    const listData = (await listResponse.json()) as { subscriptions: Array<Record<string, unknown>> };
    expect(listData.subscriptions).toHaveLength(1);
    expect(listData.subscriptions[0]).toMatchObject({ name: "Managed", token: created.subscription.token });
    expect(listData.subscriptions[0]).not.toHaveProperty("config");
    expect(listData.subscriptions[0]).not.toHaveProperty("nodes");

    const detailResponse = await handleRequest(authenticatedRequest(recordUrl, cookie), env);
    const detail = (await detailResponse.json()) as { subscription: { config?: Record<string, unknown> } };
    expect(detail.subscription.config).toHaveProperty("sources");

    const settingsResponse = await handleRequest(
      authenticatedRequest(recordUrl, cookie, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed", autoUpdateInterval: null, smartNodeMatchingEnabled: false }),
      }),
      env
    );
    expect(settingsResponse.status).toBe(200);

    const updateResponse = await handleRequest(
      authenticatedRequest(recordUrl, cookie, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Edited",
          yaml: "proxies: []\nrules: []\n",
          autoUpdateInterval: null,
          nodes: [],
          urls: [],
          config: { template: "minimal", sources: [{ id: "source-1", type: "nodes", content: source }] },
        }),
      }),
      env
    );
    const updated = (await updateResponse.json()) as { subscription?: { token?: string } };
    expect(updated.subscription?.token).toBe(created.subscription.token);

    const refreshResponse = await handleRequest(
      authenticatedRequest(`${recordUrl}/refresh`, cookie, { method: "POST" }),
      env
    );
    const refreshData = (await refreshResponse.json()) as { nodeCount?: number };
    expect(refreshResponse.status).toBe(200);
    expect(refreshData.nodeCount).toBe(1);

    const deleteResponse = await handleRequest(
      authenticatedRequest(recordUrl, cookie, { method: "DELETE" }),
      env
    );
    expect(deleteResponse.status).toBe(204);
    expect(kv.values.has(`edge-config:${created.subscription.token}`)).toBe(false);
  });

  it("migrates legacy rolling YAML records to persistent KV on access", async () => {
    const kv = new MemoryKv();
    const token = "a".repeat(20);
    kv.values.set(
      `edge-config:${token}`,
      JSON.stringify({ version: 1, name: "Legacy", yaml: "proxies: []\n", createdAt: "2026-01-01T00:00:00.000Z" })
    );
    const ctx = createContext();

    const response = await handleRequest(new Request(`https://edge.test/config/${token}`), { SUB_KV: kv }, ctx);
    await Promise.all(ctx.promises);

    expect(response.status).toBe(200);
    const migrated = JSON.parse(kv.values.get(`edge-config:${token}`) || "{}") as {
      version?: number;
      conversionProfileId?: string;
    };
    expect(migrated.version).toBe(2);
    expect(migrated.conversionProfileId).toBe("native");
    expect(kv.writes.at(-1)?.expirationTtl).toBeUndefined();
  });

  it("normalizes unknown stored profiles to native without contacting a converter", async () => {
    const kv = new MemoryKv();
    const token = "c".repeat(20);
    const key = `edge-config:${token}`;
    kv.values.set(
      key,
      JSON.stringify({
        version: 2,
        name: "Unknown Profile",
        yaml: "proxies: []\nrules: []\n",
        autoUpdateInterval: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        conversionProfileId: "https://example.com/config.ini",
      })
    );
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const ctx = createContext();
      const response = await handleRequest(new Request(`https://edge.test/config/${token}`), { SUB_KV: kv }, ctx);
      await Promise.all(ctx.promises);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("proxies: []");
      expect(fetchImpl).not.toHaveBeenCalled();
      const normalized = JSON.parse(kv.values.get(key) || "{}") as { conversionProfileId?: string };
      expect(normalized.conversionProfileId).toBe("native");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refreshes due subscriptions from their saved sources", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const source =
      "vless://00000000-0000-4000-8000-000000000000@example.com:443?encryption=none&security=tls#Edge";
    const createResponse = await handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Managed Edge Config",
          yaml: "proxies: []\nrules: []\n",
          autoUpdateInterval: 3600,
          urls: [],
          nodes: [],
          config: {
            template: "minimal",
            sources: [{ id: "source-1", type: "nodes", content: source }],
          },
        }),
      }),
      env
    );
    const created = (await createResponse.json()) as { subscription: { token: string; nextUpdateAt: string } };
    const scheduledAt = new Date(created.subscription.nextUpdateAt);

    const summary = await runScheduledSubscriptionUpdates({ SUB_KV: kv }, new Date(scheduledAt.getTime() + 1000));
    const stored = JSON.parse(kv.values.get(`edge-config:${created.subscription.token}`) || "{}") as {
      yaml?: string;
      lastSuccessAt?: string;
      lastError?: string;
    };

    expect(summary).toMatchObject({ scanned: 1, due: 1, updated: 1, failed: 0 });
    expect(stored.yaml).toContain("example.com");
    expect(stored.lastSuccessAt).toBeTruthy();
    expect(stored.lastError).toBeUndefined();
  });

  it("scheduled refresh retries remote URL sources with client user agents", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const yaml = [
      "proxies:",
      "  - name: Remote",
      "    type: trojan",
      "    server: remote.example.com",
      "    port: 443",
      "    password: secret",
    ].join("\n");
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const userAgent = new Headers(init?.headers).get("user-agent") || "";
      if (userAgent.startsWith("v2rayN/")) {
        return new Response("<!doctype html><html><body>blocked</body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (userAgent.startsWith("mihomo/")) {
        return new Response(yaml, { headers: { "content-type": "text/yaml" } });
      }
      return new Response("<!doctype html><html><body>cover</body></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const createResponse = await handleRequest(
        authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Remote URL Config",
            yaml: "proxies: []\nrules: []\n",
            autoUpdateInterval: 3600,
            urls: ["https://example.com/sub.yaml"],
            nodes: [],
            config: {
              template: "minimal",
              sources: [{ id: "source-1", type: "url", content: "https://example.com/sub.yaml" }],
            },
          }),
        }),
        env
      );
      const created = (await createResponse.json()) as { subscription: { token: string; nextUpdateAt: string } };
      expect(createResponse.status).toBe(200);

      const summary = await runScheduledSubscriptionUpdates(
        { SUB_KV: kv },
        new Date(new Date(created.subscription.nextUpdateAt).getTime() + 1000)
      );
      const stored = JSON.parse(kv.values.get(`edge-config:${created.subscription.token}`) || "{}") as {
        yaml?: string;
        lastError?: string;
      };

      expect(summary).toMatchObject({ scanned: 1, due: 1, updated: 1, failed: 0 });
      expect(stored.yaml).toContain("remote.example.com");
      expect(stored.lastError).toBeUndefined();
      expect(fetchImpl.mock.calls.some((call) => String(new Headers(call[1]?.headers).get("user-agent") || "").startsWith("v2rayN/"))).toBe(true);
      expect(fetchImpl.mock.calls.some((call) => String(new Headers(call[1]?.headers).get("user-agent") || "").startsWith("mihomo/"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("caps actual remote requests across a scheduled refresh", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const sources = Array.from({ length: 32 }, (_, index) => ({
      id: `source-${index}`,
      type: "url",
      content: `https://source-${index}.example.com/sub.yaml`,
    }));
    const fetchImpl = vi.fn(async () =>
      new Response("<!doctype html><html><body>blocked</body></html>", {
        headers: { "content-type": "text/html" },
      })
    );
    vi.stubGlobal("fetch", fetchImpl);

    try {
      const createResponse = await handleRequest(
        authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Budgeted refresh",
            yaml: "proxies: []\nrules: []\n",
            autoUpdateInterval: 3600,
            urls: sources.map((source) => source.content),
            nodes: [],
            config: { template: "minimal", sources },
          }),
        }),
        env
      );
      const created = (await createResponse.json()) as {
        subscription: { nextUpdateAt: string };
      };

      const summary = await runScheduledSubscriptionUpdates(
        { SUB_KV: kv },
        new Date(new Date(created.subscription.nextUpdateAt).getTime() + 1000)
      );

      expect(summary).toMatchObject({ scanned: 1, due: 1, updated: 0, failed: 1 });
      expect(fetchImpl).toHaveBeenCalledTimes(MAX_REMOTE_REQUESTS_PER_REFRESH);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("allows an authenticated or CRON_SECRET request to run subscription updates", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv, { CRON_SECRET: "cron-secret" });
    const cookie = await login(env);
    const missing = await handleRequest(
      new Request("https://edge.test/api/cron/update-subscriptions", { method: "POST" }),
      createEnv(kv)
    );
    expect(missing.status).toBe(503);

    const unauthorized = await handleRequest(
      new Request("https://edge.test/api/cron/update-subscriptions", {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
      }),
      env
    );
    expect(unauthorized.status).toBe(401);

    const method = await handleRequest(new Request("https://edge.test/api/cron/update-subscriptions"), env);
    expect(method.status).toBe(405);

    const bySecret = await handleRequest(
      new Request("https://edge.test/api/cron/update-subscriptions", {
        method: "POST",
        headers: { Authorization: "Bearer cron-secret" },
      }),
      env
    );
    expect(bySecret.status).toBe(200);
    await expect(bySecret.json()).resolves.toMatchObject({ success: true, scanned: 0 });

    const bySession = await handleRequest(
      authenticatedRequest("https://edge.test/api/cron/update-subscriptions", cookie, { method: "POST" }),
      env
    );
    expect(bySession.status).toBe(200);
  });

  it("skips subscriptions whose KV metadata says they are not due", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const source =
      "vless://00000000-0000-4000-8000-000000000000@example.com:443?encryption=none&security=tls#Edge";
    const createResponse = await handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Not Due",
          yaml: "proxies: []\nrules: []\n",
          autoUpdateInterval: 3600,
          urls: [],
          nodes: [],
          config: { sources: [{ id: "source-1", type: "nodes", content: source }] },
        }),
      }),
      env
    );
    const created = (await createResponse.json()) as { subscription: { token: string; nextUpdateAt: string } };
    const key = `edge-config:${created.subscription.token}`;
    kv.reads.length = 0;

    const summary = await runScheduledSubscriptionUpdates(
      env,
      new Date(new Date(created.subscription.nextUpdateAt).getTime() - 1000)
    );

    expect(summary).toMatchObject({ scanned: 1, due: 0, updated: 0, failed: 0, skipped: 1 });
    expect(kv.reads).not.toContain(key);
    expect(kv.metadata.get(key)).toMatchObject({ version: 1, autoUpdate: true });
  });

  it("backfills schedule metadata once for records from earlier deployments", async () => {
    const kv = new MemoryKv();
    const token = "b".repeat(20);
    const key = `edge-config:${token}`;
    kv.values.set(
      key,
      JSON.stringify({
        version: 2,
        name: "Legacy Metadata",
        yaml: "proxies: []\nrules: []\n",
        urls: [],
        nodes: [],
        config: {},
        subscriptionInfo: {},
        autoUpdateInterval: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })
    );

    await expect(runScheduledSubscriptionUpdates({ SUB_KV: kv })).resolves.toMatchObject({
      scanned: 1,
      skipped: 1,
    });
    expect(kv.reads).toContain(key);
    expect(kv.metadata.get(key)).toEqual({ version: 1, autoUpdate: false });

    kv.reads.length = 0;
    await runScheduledSubscriptionUpdates({ SUB_KV: kv });
    expect(kv.reads).not.toContain(key);
  });

  it("serves authenticated rule search from a persistent KV index", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const fetchImpl = createRuleTreeFetch();
    vi.stubGlobal("fetch", fetchImpl);

    try {
      const anonymous = await handleRequest(new Request("https://edge.test/api/rules/search?keyword=google"), env);
      expect(anonymous.status).toBe(401);

      const first = await handleRequest(
        authenticatedRequest("https://edge.test/api/rules/search?keyword=google&page=1&size=20", cookie),
        env
      );
      const firstData = (await first.json()) as { items: Array<{ id?: string }>; totalRules?: number };
      expect(first.status).toBe(200);
      expect(firstData.items).toEqual([expect.objectContaining({ id: "google" })]);
      expect(firstData.totalRules).toBe(2);
      expect(kv.values.has(RULE_INDEX_CACHE_KEY)).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      const second = await handleRequest(
        authenticatedRequest("https://edge.test/api/rules/search?keyword=cn&type=geoip", cookie),
        env
      );
      expect(second.status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("protects rule status and refresh routes and enforces their methods", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);

    expect((await handleRequest(new Request("https://edge.test/api/rules/status"), env)).status).toBe(401);
    expect(
      (await handleRequest(new Request("https://edge.test/api/rules/refresh", { method: "POST" }), env)).status
    ).toBe(401);

    const cookie = await login(env);
    const statusMethod = await handleRequest(
      authenticatedRequest("https://edge.test/api/rules/status", cookie, { method: "POST" }),
      env
    );
    expect(statusMethod.status).toBe(405);
    expect(statusMethod.headers.get("allow")).toBe("GET");

    const refreshMethod = await handleRequest(
      authenticatedRequest("https://edge.test/api/rules/refresh", cookie),
      env
    );
    expect(refreshMethod.status).toBe(405);
    expect(refreshMethod.headers.get("allow")).toBe("POST");
  });

  it("reads rule status from KV without contacting the upstream", async () => {
    const now = Date.parse("2026-08-06T04:00:00.000Z");
    const kv = new MemoryKv();
    kv.values.set(
      RULE_INDEX_CACHE_KEY,
      JSON.stringify({
        geosite: ["google", "youtube"],
        geoip: ["cn"],
        fetchedAt: now - 60_000,
        expiresAt: now + 3_600_000,
        source: "remote",
      })
    );
    const env = createEnv(kv);
    const cookie = await login(env);
    const fetchImpl = vi.fn();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    vi.stubGlobal("fetch", fetchImpl);

    try {
      const response = await handleRequest(
        authenticatedRequest("https://edge.test/api/rules/status", cookie),
        env
      );
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(data).toMatchObject({
        source: "remote",
        sourceLabel: "MetaCubeX/meta-rules-dat",
        geositeCount: 2,
        geoipCount: 1,
        totalRules: 3,
        fetchedAt: now - 60_000,
        expiresAt: now + 3_600_000,
        schedule: RULE_CATALOG_CRON,
        nextScheduledAt: Date.parse("2026-08-07T03:17:00.000Z"),
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(kv.reads.filter((key) => key === RULE_INDEX_CACHE_KEY)).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("reports the bundled rule catalog when KV has no valid remote index", async () => {
    for (const stored of [undefined, "not-json"]) {
      const kv = new MemoryKv();
      if (stored) kv.values.set(RULE_INDEX_CACHE_KEY, stored);
      const env = createEnv(kv);
      const cookie = await login(env);
      const response = await handleRequest(
        authenticatedRequest("https://edge.test/api/rules/status", cookie),
        env
      );
      const data = (await response.json()) as {
        source?: string;
        totalRules?: number;
        fetchedAt?: number | null;
        expiresAt?: number | null;
      };

      expect(response.status).toBe(200);
      expect(data.source).toBe("bundled");
      expect(data.totalRules).toBeGreaterThan(0);
      expect(data.fetchedAt).toBeNull();
      expect(data.expiresAt).toBeNull();
    }
  });

  it("refreshes the rule catalog on demand and returns the new status", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const fetchImpl = createRuleTreeFetch();
    vi.stubGlobal("fetch", fetchImpl);

    try {
      const response = await handleRequest(
        authenticatedRequest("https://edge.test/api/rules/refresh", cookie, { method: "POST" }),
        env
      );
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data).toMatchObject({
        source: "remote",
        refreshStatus: "refreshed",
        geositeCount: 1,
        geoipCount: 1,
        totalRules: 2,
      });
      expect(kv.values.has(RULE_INDEX_CACHE_KEY)).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps and reports a stale rule index when manual refresh fails", async () => {
    const now = Date.now();
    const kv = new MemoryKv();
    kv.values.set(
      RULE_INDEX_CACHE_KEY,
      JSON.stringify({
        geosite: ["google"],
        geoip: ["cn"],
        fetchedAt: now - 86_400_000,
        expiresAt: now - 1,
        source: "remote",
      })
    );
    const env = createEnv(kv);
    const cookie = await login(env);
    const fetchImpl = vi.fn(async () =>
      new Response("private upstream response", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchImpl);

    try {
      const response = await handleRequest(
        authenticatedRequest("https://edge.test/api/rules/refresh", cookie, { method: "POST" }),
        env
      );
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data).toMatchObject({
        source: "stale",
        refreshStatus: "stale",
        geositeCount: 1,
        geoipCount: 1,
        totalRules: 2,
      });
      expect(data.error).toBe("远端同步失败，当前继续使用缓存");
      expect(JSON.stringify(data)).not.toContain("private upstream response");
      expect(fetchImpl).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports manual rule refresh as unavailable when KV is not bound", async () => {
    const env = createEnv();
    const cookie = await login(env);
    const response = await handleRequest(
      authenticatedRequest("https://edge.test/api/rules/refresh", cookie, { method: "POST" }),
      env
    );
    const data = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(data).toEqual({ error: "KV未绑定" });
  });

  it("calculates the next daily rule catalog run in UTC", () => {
    expect(getNextRuleCatalogRunAt(Date.parse("2026-08-06T03:16:59.000Z"))).toBe(
      Date.parse("2026-08-06T03:17:00.000Z")
    );
    expect(getNextRuleCatalogRunAt(Date.parse("2026-08-06T03:17:00.000Z"))).toBe(
      Date.parse("2026-08-07T03:17:00.000Z")
    );
  });

  it("serves CN rule candidates through the Edge rules API", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const fetchImpl = createRuleTreeFetch(
      ["geosite/google.mrs", "geosite/google-cn.mrs", "geosite/geolocation-cn.mrs"],
      {
        "/geosite/google-cn.list": "+.google.cn\n",
        "/geosite/geolocation-cn.list": "+.covered.cn\n",
      }
    );
    vi.stubGlobal("fetch", fetchImpl);

    try {
      const response = await handleRequest(
        authenticatedRequest("https://edge.test/api/rules/cn-candidates?modules=google", cookie),
        env
      );
      const data = (await response.json()) as { items?: Array<{ id?: string }> };

      expect(response.status).toBe(200);
      expect(data.items).toEqual([expect.objectContaining({ id: "google-cn" })]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refreshes the persistent rule index on the daily catalog cron", async () => {
    const kv = new MemoryKv();
    const ctx = createContext();
    const fetchImpl = createRuleTreeFetch();
    vi.stubGlobal("fetch", fetchImpl);

    try {
      worker.scheduled(
        { cron: RULE_CATALOG_CRON, scheduledTime: Date.parse("2026-07-21T03:17:00.000Z") },
        createEnv(kv),
        ctx
      );
      await Promise.all(ctx.promises);

      expect(kv.values.has(RULE_INDEX_CACHE_KEY)).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the last successful YAML when a scheduled refresh fails", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const previousYaml = "proxies:\n  - name: Previous\n    type: direct\nrules: []\n";
    const createResponse = await handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Fallback Config",
          yaml: previousYaml,
          autoUpdateInterval: 3600,
          urls: ["http://127.0.0.1/sub"],
          nodes: [{ name: "Previous", type: "direct" }],
          config: {
            template: "minimal",
            sources: [{ id: "source-1", type: "url", content: "http://127.0.0.1/sub" }],
          },
        }),
      }),
      env
    );
    const created = (await createResponse.json()) as { subscription: { token: string; nextUpdateAt: string } };

    const summary = await runScheduledSubscriptionUpdates(
      { SUB_KV: kv },
      new Date(new Date(created.subscription.nextUpdateAt).getTime() + 1000)
    );
    const stored = JSON.parse(kv.values.get(`edge-config:${created.subscription.token}`) || "{}") as {
      yaml?: string;
      lastError?: string;
    };

    expect(summary).toMatchObject({ scanned: 1, due: 1, updated: 0, failed: 1 });
    expect(stored.yaml).toBe(previousYaml);
    expect(stored.lastError).toBeTruthy();
  });

  it("rejects private subscription import targets", async () => {
    const env = createEnv();
    const cookie = await login(env);
    const response = await handleRequest(
      authenticatedRequest("https://edge.test/api/source-import", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "http://127.0.0.1/sub" }),
      }),
      env
    );
    const data = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(data.error).toContain("内网地址");
  });

  it("rejects HTML subscription imports before parsing", async () => {
    const env = createEnv();
    const cookie = await login(env);
    const fetchImpl = vi.fn(async () =>
      new Response("<!doctype html><html><head></head><body>blocked</body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    );
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const response = await handleRequest(
        authenticatedRequest("https://edge.test/api/source-import", cookie, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: "https://example.com/sub" }),
        }),
        env
      );
      const data = (await response.json()) as { error?: string; errorInfo?: { category?: string } };
      expect(response.status).toBe(400);
      expect(data.error).toContain("检测到 HTML 页面内容");
      expect(data.errorInfo?.category).toBe("parse");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("caps node connectivity tests", async () => {
    const env = createEnv();
    const cookie = await login(env);
    const response = await handleRequest(
      authenticatedRequest("https://edge.test/test", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodes: Array.from({ length: MAX_TEST_NODES + 1 }, () => ({ ip: "example.com", port: 443 })) }),
      }),
      env
    );

    expect(response.status).toBe(413);
  });
});
