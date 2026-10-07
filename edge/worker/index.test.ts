import { beforeEach, describe, expect, it, vi } from "vitest";
import { getClashConversionProfile } from "@subboost/core/subscription/clash-conversion-profiles";
import {
  KV_TTL,
  MAX_STORED_SUBSCRIPTION_BYTES,
  MAX_STORED_YAML_BYTES,
  MAX_MANAGED_SUBSCRIPTION_NODES,
  MAX_REMOTE_REQUESTS_PER_REFRESH,
  MAX_TEST_NODES,
  SUBSCRIPTION_SCHEDULE_GRACE_MS,
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
import { SubscriptionStore, type SubscriptionStoreState } from "./subscription-store";
import type { ExecutionContextLike, KVNamespaceLike, WorkerEnv } from "./types";
import { safeBase64Decode } from "./encoding";
import { parseNodeLink } from "@subboost/core/parser";
import { generateClashYaml } from "@subboost/core/generator";
import { buildGenerateOptionsFromConfig } from "@subboost/core/subscription/config-utils";

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

// Minimal stand-in for the SQLite storage used by SubscriptionStore.
class MemorySubscriptionStoreState implements SubscriptionStoreState {
  private row: Record<string, unknown> | undefined;
  private readonly chunks = new Map<number, string>();
  readonly storage: SubscriptionStoreState["storage"] = {
    sql: {
      exec: (query: string, ...bindings: (string | number | null)[]) => {
        const rows: Record<string, unknown>[] = [];
        if (query.startsWith("SELECT * FROM subscription_state")) {
          if (this.row) rows.push({ ...this.row });
        } else if (query.startsWith("SELECT content FROM subscription_chunks")) {
          for (const [, content] of [...this.chunks].sort(([a], [b]) => a - b)) rows.push({ content });
        } else if (query.startsWith("DELETE FROM subscription_chunks")) {
          this.chunks.clear();
        } else if (query.startsWith("INSERT INTO subscription_chunks")) {
          this.chunks.set(bindings[0] as number, bindings[1] as string);
        } else if (query.startsWith("INSERT OR REPLACE INTO subscription_state")) {
          const [token, present, revision, metadata, dirty] = bindings;
          this.row = { id: 1, token, present, revision, metadata, dirty };
        } else if (query.startsWith("UPDATE subscription_state SET dirty = 0")) {
          if (this.row) this.row.dirty = 0;
        } else if (!query.startsWith("CREATE TABLE")) {
          throw new Error(`Unsupported SQL in test: ${query}`);
        }
        return { toArray: () => rows as never[] };
      },
    },
    transactionSync: (callback) => callback(),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  };

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }
}

function attachSubscriptionStore(env: WorkerEnv): WorkerEnv {
  const stores = new Map<string, SubscriptionStore>();
  env.SUB_STORE = {
    idFromName: (name) => name,
    get: (id) => ({
      fetch: (request) => {
        const name = String(id);
        let store = stores.get(name);
        if (!store) {
          store = new SubscriptionStore(new MemorySubscriptionStoreState(), env);
          stores.set(name, store);
        }
        return store.fetch(request);
      },
    }),
  };
  return env;
}

// In-memory stand-in for caches.default (Cache API).
class MemoryCache {
  readonly entries = new Map<string, { body: string; status: number; headers: [string, string][] }>();

  async match(request: Request): Promise<Response | undefined> {
    const entry = this.entries.get(request.url);
    return entry ? new Response(entry.body, { status: entry.status, headers: entry.headers }) : undefined;
  }

  async put(request: Request, response: Response): Promise<void> {
    this.entries.set(request.url, { body: await response.text(), status: response.status, headers: [...response.headers] });
  }
}

function seedScheduledRecord(kv: MemoryKv, token: string, nextUpdateAt: string): void {
  const source = "vless://00000000-0000-4000-8000-000000000000@example.com:443?encryption=none&security=tls#Edge";
  const key = `edge-config:${token}`;
  kv.values.set(key, JSON.stringify({
    version: 2,
    name: `Scheduled ${token.slice(-4)}`,
    yaml: "proxies: []\nrules: []\n",
    urls: [],
    nodes: [parseNodeLink(source)],
    config: { template: "minimal", sources: [{ id: "source-1", type: "nodes", content: source }] },
    conversionProfileId: "native",
    subscriptionInfo: {},
    autoUpdateInterval: 6 * 3600,
    createdAt: "2025-12-31T00:00:00.000Z",
    updatedAt: "2025-12-31T00:00:00.000Z",
    nextUpdateAt,
  }));
  kv.metadata.set(key, { version: 1, autoUpdate: true, nextUpdateAt });
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
  it("adds v2rayN output without changing existing URLs, stored YAML or GET/HEAD caches", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const yaml = "proxies:\n  - {name: 香港, type: trojan, server: example.com, port: 443, password: secret}\nrules: [MATCH,DIRECT]\n";
    const saved = await handleRequest(authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Both formats", yaml, subscriptionInfo: { total: 1024 }, conversionProfileId: "native" }),
    }), env);
    const { subscription } = await saved.json() as { subscription: { token: string; subscriptionUrl: string } };
    const key = `edge-config:${subscription.token}`;
    const stored = kv.values.get(key);
    const converted = await handleRequest(new Request(`${subscription.subscriptionUrl}?format=v2rayn`), env);
    expect(converted.status).toBe(200);
    expect(converted.headers.get("content-type")).toContain("text/plain");
    expect(converted.headers.get("subscription-userinfo")).toBe("total=1024");
    const content = await converted.text();
    expect(safeBase64Decode(content)).toContain("trojan://secret@example.com:443");
    for (const query of ["", "?format=clash", "?raw=1", "?format=legacy-value"]) {
      const legacy = await handleRequest(new Request(subscription.subscriptionUrl + query, { headers: { "User-Agent": "v2rayN/7.0" } }), env);
      expect(legacy.headers.get("content-type")).toContain("text/yaml");
      expect(await legacy.text()).toBe(yaml);
    }
    const head = await handleRequest(new Request(`${subscription.subscriptionUrl}?format=v2rayn`, { method: "HEAD" }), env);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe(String(content.length));
    expect(await (await handleRequest(new Request(`${subscription.subscriptionUrl}?format=v2rayn`), env)).text()).toBe(content);
    expect(kv.values.get(key)).toBe(stored);
  });

  it("exports v2rayN locally for saved remote profiles and invalidates it after updates/deletion", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const body = { name: "Remote profile", yaml: "proxies: [{name: old, type: trojan, server: example.com, port: 443, password: old}]", conversionProfileId: "acl4ssr-online-mini" };
    const saved = await handleRequest(authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), env);
    const { subscription } = await saved.json() as { subscription: { token: string; subscriptionUrl: string } };
    const link = `${subscription.subscriptionUrl}?format=v2rayn`;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected converter request"));
    try {
      expect(safeBase64Decode(await (await handleRequest(new Request(link), env)).text())).toContain("trojan://old@");
      expect(fetchSpy).not.toHaveBeenCalled();
      const updated = await handleRequest(authenticatedRequest(`https://edge.test/api/subscriptions/${subscription.token}`, cookie, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, yaml: body.yaml.replaceAll("old", "new") }),
      }), env);
      expect(updated.status).toBe(200);
      expect((await updated.json() as { subscription: { subscriptionUrl: string } }).subscription.subscriptionUrl).toBe(subscription.subscriptionUrl);
      expect(safeBase64Decode(await (await handleRequest(new Request(link), env)).text())).toContain("trojan://new@");
      await handleRequest(authenticatedRequest(`https://edge.test/api/subscriptions/${subscription.token}`, cookie, { method: "DELETE" }), env);
      expect((await handleRequest(new Request(link), env)).status).toBe(404);
      expect((await handleRequest(new Request(subscription.subscriptionUrl), env)).status).toBe(404);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns 422 for unsupported v2rayN snapshots without breaking the original YAML", async () => {
    const kv = new MemoryKv();
    const token = "bbbbbbbbbbbbbbbbbbbb";
    const yaml = "proxies: [{name: snell, type: snell, server: example.com, port: 443, psk: secret}]";
    kv.values.set(`edge-config:${token}`, JSON.stringify({ version: 2, name: "Legacy", yaml, conversionProfileId: "native" }));
    for (const method of ["GET", "HEAD"]) {
      const response = await handleRequest(new Request(`https://edge.test/config/${token}?format=v2rayn`, { method }), createEnv(kv));
      expect(response.status).toBe(422);
      if (method === "HEAD") expect(await response.text()).toBe("");
    }
    expect(await (await handleRequest(new Request(`https://edge.test/config/${token}`), createEnv(kv))).text()).toBe(yaml);
  });

  it("preserves auto-update schedule and failure information when PATCH only renames a subscription", async () => {
    const kv = new MemoryKv();
    const token = "cccccccccccccccccccc";
    const record = { version: 2, name: "Before", yaml: "proxies: []", conversionProfileId: "native", urls: ["https://example.com/sub"], autoUpdateInterval: 3600, nextUpdateAt: "2026-09-20T01:00:00.000Z", lastError: "upstream failed" };
    kv.values.set(`edge-config:${token}`, JSON.stringify(record));
    const env = createEnv(kv);
    const cookie = await login(env);
    const result = await handleRequest(authenticatedRequest(`https://edge.test/api/subscriptions/${token}`, cookie, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "After" }),
    }), env);
    expect(result.status).toBe(200);
    expect(JSON.parse(kv.values.get(`edge-config:${token}`)!)).toMatchObject({ ...record, name: "After" });
  });

  it("requires authentication for POST conversion even with a public short-link query id", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected outbound request"));
    try {
      for (const path of ["/sub", "/clash", "/"]) {
        const response = await handleRequest(new Request(`https://edge.test${path}?id=public-link`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "https://example.com/sub" }),
        }), createEnv(new MemoryKv()));
        expect(response.status).toBe(401);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
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

  it("creates legacy short links and refreshes their rolling TTL at most daily", async () => {
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
    // Created moments ago, so this read must not spend a KV write on the TTL.
    expect(kv.writes).toHaveLength(1);

    const stale = JSON.parse(kv.values.get(created.id)!) as Record<string, unknown>;
    kv.values.set(created.id, JSON.stringify({ ...stale, refreshedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 }));
    const staleCtx = createContext();
    expect((await handleRequest(new Request(`${created.shortUrl}&raw=true`), { SUB_KV: kv }, staleCtx)).status).toBe(200);
    await Promise.all(staleCtx.promises);
    expect(kv.writes).toHaveLength(2);
    expect(kv.writes.at(-1)).toEqual({ key: created.id, expirationTtl: KV_TTL });
    expect(Date.now() - (JSON.parse(kv.values.get(created.id)!) as { refreshedAt: number }).refreshedAt).toBeLessThan(60_000);
  });

  it("refreshes short links created before refresh tracking", async () => {
    const kv = new MemoryKv();
    const id = "abcdef123456";
    kv.values.set(id, JSON.stringify({
      template: "",
      source: "vless://00000000-0000-4000-8000-000000000000@example.com:443?security=tls#HK",
      dedup: true,
    }));
    const ctx = createContext();
    const response = await handleRequest(new Request(`https://edge.test/sub?id=${id}&raw=true`), { SUB_KV: kv }, ctx);
    await Promise.all(ctx.promises);

    expect(response.status).toBe(200);
    expect(kv.writes).toEqual([{ key: id, expirationTtl: KV_TTL }]);
    expect(JSON.parse(kv.values.get(id)!)).toMatchObject({ dedup: true, refreshedAt: expect.any(Number) });
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
    const yaml = `proxies: []\npayload: ${"a".repeat(previousLimit)}\n`;

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

    const updatedYaml = `proxies: []\npayload: ${"b".repeat(previousLimit)}\n`;
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

  it("rejects malformed YAML and cyclic proxy references before writing", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const malformed = await handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Malformed", yaml: "proxies: [" }),
      }), env
    );
    expect(malformed.status).toBe(400);
    const cyclic = await handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Cyclic",
          yaml: "proxies: []\nproxy-groups:\n  - name: A\n    type: select\n    proxies: [B]\n  - name: B\n    type: select\n    proxies: [A]\n",
        }),
      }), env
    );
    expect(cyclic.status).toBe(400);
    expect(Array.from(kv.values.keys()).filter(key => key.startsWith("edge-config:"))).toHaveLength(0);
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

  it("caches converted configs, answers 304, and falls back when every converter fails", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv, { SUBCONVERTER_BACKEND: "https://converter.test/sub" });
    const cookie = await login(env);
    const createResponse = await handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Cached Profile",
          yaml: "proxies: []\nrules:\n  - MATCH,DIRECT\n",
          conversionProfileId: "acl4ssr-online-mini",
        }),
      }),
      env
    );
    const { subscription } = (await createResponse.json()) as { subscription: { subscriptionUrl: string } };
    const cache = new MemoryCache();
    let converterUp = true;
    const fetchImpl = vi.fn(async () =>
      converterUp
        ? new Response("proxies: [{name: Probe, type: trojan, server: example.com, port: 443, password: fake}]\nproxy-groups: [{name: Proxy, type: select, proxies: [Probe]}]\nrules:\n  - MATCH,Proxy\n")
        : new Response("down", { status: 500 })
    );
    vi.stubGlobal("caches", { default: cache });
    vi.stubGlobal("fetch", fetchImpl);
    const fetchConfig = (init?: RequestInit) => {
      resetStoredConfigCache(); // look past the 30s isolate cache
      return handleRequest(new Request(subscription.subscriptionUrl, init), env);
    };
    try {
      const first = await fetchConfig();
      expect(first.headers.get("x-subboost-converter-cache")).toBe("miss");
      expect(await first.text()).toContain("MATCH,Proxy");
      const etag = first.headers.get("etag");
      expect(etag).toMatch(/^"[a-f0-9]{32}-c\d+"$/);

      const second = await fetchConfig();
      expect(second.headers.get("x-subboost-converter-cache")).toBe("hit");
      expect(second.headers.get("cache-control")).toBe("no-store");
      expect(second.headers.get("etag")).toBe(etag);
      expect(await second.text()).toContain("MATCH,Proxy");
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      const notModified = await fetchConfig({ headers: { "If-None-Match": etag! } });
      expect(notModified.status).toBe(304);
      expect(await notModified.text()).toBe("");

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 31 * 60 * 1000);
      converterUp = false;
      const stale = await fetchConfig();
      expect(stale.status).toBe(200);
      expect(stale.headers.get("x-subboost-converter-cache")).toBe("stale");
      expect(await stale.text()).toContain("MATCH,Proxy");

      cache.entries.clear();
      const native = await fetchConfig();
      expect(native.status).toBe(200);
      expect(native.headers.get("x-subboost-converter-fallback")).toBe("native");
      expect(await native.text()).toContain("MATCH,DIRECT");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("answers 304 for unchanged native configs and keeps full bodies for other clients", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const createResponse = await handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Native", yaml: "proxies: []\nrules: []\n" }),
      }),
      env
    );
    const { subscription } = (await createResponse.json()) as { subscription: { subscriptionUrl: string } };

    const first = await handleRequest(new Request(subscription.subscriptionUrl), env);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"[a-f0-9]{32}"$/);
    const conditional = await handleRequest(
      new Request(subscription.subscriptionUrl, { headers: { "If-None-Match": etag } }),
      env
    );
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("profile-update-interval")).toBeTruthy();
    // The isolate cache must still hand a full body to a client without the ETag.
    const plain = await handleRequest(new Request(subscription.subscriptionUrl), env);
    expect(plain.status).toBe(200);
    expect(await plain.text()).toContain("rules: []");
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
      expect(capabilityUrl).toMatch(/^https:\/\/edge\.test\/config-cap\/[A-Za-z0-9_-]+$/);
      expect(capabilityUrl).not.toContain(created.subscription.token);
      // Conversions must not spend a KV write per client poll.
      expect(kv.writes.some(write => write.key.startsWith("edge-config-capability:"))).toBe(false);
      const capabilityResponse = await handleRequest(new Request(capabilityUrl || ""), env);
      expect(capabilityResponse.status).toBe(200);
      expect(await capabilityResponse.text()).toContain("MATCH,DIRECT");
      const configKey = `edge-config:${created.subscription.token}`;
      const snapshot = kv.values.get(configKey)!;
      kv.values.set(configKey, JSON.stringify({ ...JSON.parse(snapshot), name: "Changed" }));
      // A capability is pinned to the revision whose proxies it is merged with.
      expect((await handleRequest(new Request(capabilityUrl || ""), env)).status).toBe(404);
      kv.values.set(configKey, snapshot);
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
          nodes: [parseNodeLink(source)],
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
          nodes: [parseNodeLink(source)],
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
          nodes: [parseNodeLink(source)],
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
            nodes: [{ name: "Remote", type: "trojan", server: "remote.example.com", port: 443, password: "secret" }],
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
            nodes: [{ name: "Previous", type: "direct" }],
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
          nodes: [parseNodeLink(source)],
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
      new Date(new Date(created.subscription.nextUpdateAt).getTime() - SUBSCRIPTION_SCHEDULE_GRACE_MS - 1000)
    );

    expect(summary).toMatchObject({ scanned: 1, due: 0, updated: 0, failed: 0, skipped: 1 });
    expect(kv.reads).not.toContain(key);
    expect(kv.metadata.get(key)).toMatchObject({ version: 1, autoUpdate: true });
  });

  it("refreshes a record due seconds after the cron fires instead of skipping a whole period", async () => {
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
          name: "Six Hourly",
          yaml: "proxies: []\nrules: []\n",
          autoUpdateInterval: 6 * 3600,
          urls: [],
          nodes: [parseNodeLink(source)],
          config: { template: "minimal", sources: [{ id: "source-1", type: "nodes", content: source }] },
        }),
      }),
      env
    );
    const created = (await createResponse.json()) as {
      subscription: { token: string; nextUpdateAt: string; subscriptionUrl: string };
    };

    // The cron fires on the hour; the record was saved a few seconds later.
    const cronTime = new Date(new Date(created.subscription.nextUpdateAt).getTime() - 5000);
    await expect(runScheduledSubscriptionUpdates(env, cronTime)).resolves.toMatchObject({ due: 1, failed: 0 });

    const config = await handleRequest(new Request(`${created.subscription.subscriptionUrl}?raw=1`), env);
    expect(Number(config.headers.get("profile-update-interval"))).toBeGreaterThanOrEqual(6);
  });

  it("refreshes each due subscription in its own invocation through the SELF binding", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const due = "2026-01-01T00:00:00.000Z";
    const tokens = ["1", "2"].map(n => n.repeat(20));
    for (const token of tokens) seedScheduledRecord(kv, token, due);
    seedScheduledRecord(kv, "3".repeat(20), "2099-01-01T00:00:00.000Z");
    const calls: Request[] = [];
    env.SELF = {
      fetch: async (request) => {
        calls.push(request.clone());
        return handleRequest(request, env);
      },
    };

    const cronTime = new Date();
    const summary = await runScheduledSubscriptionUpdates(env, cronTime);

    expect(summary).toMatchObject({ scanned: 3, due: 2, updated: 2, failed: 0, skipped: 1, deferred: 0 });
    expect(calls.map(request => new URL(request.url).pathname)).toEqual(
      tokens.map(token => `/api/internal/refresh/${token}`)
    );
    for (const token of tokens) {
      const stored = JSON.parse(kv.values.get(`edge-config:${token}`)!) as { lastSuccessAt?: string };
      // The child invocation keeps the cron's schedule time.
      expect(stored.lastSuccessAt).toBe(cronTime.toISOString());
    }
  });

  it("caps fan-out per run and serves the most overdue subscriptions first", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    // Token order is the reverse of due order, so list order alone would be wrong.
    for (let index = 0; index < 35; index++) {
      const token = (99 - index).toString(16).padStart(20, "0");
      seedScheduledRecord(kv, token, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString());
    }
    const dispatched: string[] = [];
    env.SELF = {
      fetch: async (request) => {
        dispatched.push(new URL(request.url).pathname.split("/").at(-1)!);
        return Response.json({ outcome: "updated" });
      },
    };

    const summary = await runScheduledSubscriptionUpdates(env, new Date("2026-01-02T00:00:00.000Z"));

    expect(summary).toMatchObject({ scanned: 35, due: 30, updated: 30, deferred: 5 });
    expect(dispatched[0]).toBe((99).toString(16).padStart(20, "0"));
    expect(dispatched).not.toContain((99 - 34).toString(16).padStart(20, "0"));
  });

  it("keeps going when one dispatched refresh dies", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    seedScheduledRecord(kv, "1".repeat(20), "2026-01-01T00:00:00.000Z");
    seedScheduledRecord(kv, "2".repeat(20), "2026-01-01T00:01:00.000Z");
    let call = 0;
    env.SELF = {
      fetch: async () => {
        call += 1;
        if (call === 1) throw new Error("Worker exceeded resource limits");
        return Response.json({ outcome: "updated" });
      },
    };

    await expect(runScheduledSubscriptionUpdates(env, new Date("2026-01-02T00:00:00.000Z"))).resolves.toMatchObject({
      due: 2,
      failed: 1,
      updated: 1,
    });
  });

  it("only accepts internal refreshes signed with the deployment secret", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const token = "4".repeat(20);
    seedScheduledRecord(kv, token, "2026-01-01T00:00:00.000Z");
    const url = `https://edge.test/api/internal/refresh/${token}`;
    const body = JSON.stringify({ metadata: null });

    expect((await handleRequest(new Request(url, { method: "POST", body }), env)).status).toBe(404);
    expect((await handleRequest(new Request(url, {
      method: "POST",
      body,
      headers: { "X-EdgeSub-Internal-Auth": "0".repeat(64) },
    }), env)).status).toBe(404);
    expect((await handleRequest(new Request(url), env)).status).toBe(405);
    expect(JSON.parse(kv.values.get(`edge-config:${token}`)!).lastSuccessAt).toBeUndefined();
  });

  it("trusts not-due KV metadata without reading Durable Object records", async () => {
    const kv = new MemoryKv();
    const env = attachSubscriptionStore(createEnv(kv));
    seedScheduledRecord(kv, "5".repeat(20), "2099-01-01T00:00:00.000Z");
    const store = env.SUB_STORE!;
    const reads: unknown[] = [];
    env.SUB_STORE = { idFromName: store.idFromName, get: (id) => (reads.push(id), store.get(id)) };

    await expect(runScheduledSubscriptionUpdates(env, new Date("2026-01-01T00:00:00.000Z"))).resolves.toMatchObject({
      scanned: 1,
      skipped: 1,
    });
    expect(reads).toHaveLength(0);
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

  it("does not spend KV writes on not-due Durable Object subscriptions", async () => {
    const kv = new MemoryKv();
    const env = attachSubscriptionStore(createEnv(kv));
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
          nodes: [parseNodeLink(source)],
          config: { sources: [{ id: "source-1", type: "nodes", content: source }] },
        }),
      }),
      env
    );
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as { subscription: { token: string; nextUpdateAt: string } };
    const key = `edge-config:${created.subscription.token}`;
    const writesAfterCreate = kv.writes.filter(write => write.key === key).length;
    expect(writesAfterCreate).toBe(1);

    const beforeDue = new Date(new Date(created.subscription.nextUpdateAt).getTime() - SUBSCRIPTION_SCHEDULE_GRACE_MS - 1000);
    for (let run = 0; run < 3; run++) {
      await expect(runScheduledSubscriptionUpdates(env, beforeDue)).resolves.toMatchObject({
        scanned: 1, due: 0, updated: 0, failed: 0, skipped: 1,
      });
    }
    expect(kv.writes.filter(write => write.key === key)).toHaveLength(writesAfterCreate);
  });

  it("backfills legacy metadata through the Durable Object only once", async () => {
    const kv = new MemoryKv();
    const env = attachSubscriptionStore(createEnv(kv));
    const token = "c".repeat(20);
    const key = `edge-config:${token}`;
    kv.values.set(key, JSON.stringify({
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
    }));

    await runScheduledSubscriptionUpdates(env);
    expect(kv.metadata.get(key)).toEqual({ version: 1, autoUpdate: false });
    expect(kv.writes.filter(write => write.key === key)).toHaveLength(1);

    await runScheduledSubscriptionUpdates(env);
    await runScheduledSubscriptionUpdates(env);
    expect(kv.writes.filter(write => write.key === key)).toHaveLength(1);
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

  it.each([
    { yaml: "not-a-config" },
    { yaml: "[]" },
    { yaml: "dns: {enable: true}" },
    { yaml: "proxies: [broken]" },
    { yaml: "proxies: [{name: MissingPassword, type: trojan, server: example.com, port: 443}]" },
    { yaml: "proxies: [{name: MissingServer, type: trojan, password: test, port: 443}]" },
    { yaml: "proxy-providers: {remote: {type: http, url: 'https://example.com/sub'}}\nproxy-groups: [{name: Proxy, type: select, proxies: [Missing]}]" },
    { yaml: "proxies: []", nodes: [null] },
    { yaml: "proxies: []", nodes: [] },
    { yaml: "proxies: []", config: [] },
  ])("rejects malformed or unusable new snapshots: %j", async (payload) => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const response = await handleRequest(authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    }), env);
    expect(response.status).toBe(400);
    expect([...kv.values.keys()].filter(key => key.startsWith("edge-config:"))).toHaveLength(0);
  });

  it("regenerates a structured save with the refresh generator and preserves the token on edit", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const nodes = [{ name: "Current", type: "trojan" as const, server: "example.com", port: 443, password: "test" }];
    const config = { template: "minimal", dnsYaml: "mixed-port: 7891\ndns: {enable: false}" };
    const send = (url: string, method: string, yaml: string) => handleRequest(authenticatedRequest(url, cookie, {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ yaml, nodes, config }),
    }), env);
    const created = await send("https://edge.test/api/subscriptions", "POST", "proxies: [{name: Stale, type: direct}]");
    expect(created.status).toBe(200);
    const { subscription } = await created.json() as { subscription: { token: string; subscriptionUrl: string } };
    const expected = generateClashYaml(buildGenerateOptionsFromConfig(config, { nodes }));
    expect(JSON.parse(kv.values.get(`edge-config:${subscription.token}`)!).yaml).toBe(expected);
    const updated = await send(`https://edge.test/api/subscriptions/${subscription.token}`, "PUT", "proxies: []");
    expect(updated.status).toBe(200);
    expect((await updated.json() as { subscription: { subscriptionUrl: string } }).subscription.subscriptionUrl).toBe(subscription.subscriptionUrl);
    expect(await (await handleRequest(new Request(subscription.subscriptionUrl), env)).text()).toBe(expected);
  });

  it("accepts provider-only structured saves and rejects the same node quota as refresh", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const send = (body: unknown) => handleRequest(authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), env);
    const provider = await send({ yaml: "proxies: []", nodes: [], config: { sources: [{ id: "remote", type: "url", content: "https://example.com/sub", useProxyProviders: true }] } });
    expect(provider.status, await provider.clone().text()).toBe(200);
    const { subscription } = await provider.json() as { subscription: { token: string } };
    expect(JSON.parse(kv.values.get(`edge-config:${subscription.token}`)!).yaml).toContain("url_remote");
    const oversized = await send({ yaml: "proxies: []", nodes: Array.from({ length: MAX_MANAGED_SUBSCRIPTION_NODES + 1 }, () => ({ name: "Node", type: "direct" })) });
    expect(oversized.status).toBe(413);
  });

  it("lists active node counts and traffic usage for the dashboard", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const hk = parseNodeLink("trojan://password@hk.example.com:443?sni=hk.example.com#HK");
    const jp = parseNodeLink("trojan://password@jp.example.com:443?sni=jp.example.com#JP");
    await handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Usage",
          yaml: "proxies: []\nrules: []\n",
          nodes: [hk, jp],
          config: { deletedNodeNames: ["JP"] },
          subscriptionInfo: { upload: 1024, download: 2048, total: 10240, expire: 1798675200 },
        }),
      }),
      env
    );
    await handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "No Usage", yaml: "proxies: []\nrules: []\n" }),
      }),
      env
    );

    const list = await handleRequest(authenticatedRequest("https://edge.test/api/subscriptions", cookie), env);
    const { subscriptions } = (await list.json()) as {
      subscriptions: Array<{ name: string; nodeCount: number; usage: unknown }>;
    };
    const usage = subscriptions.find(sub => sub.name === "Usage")!;
    expect(usage.nodeCount).toBe(1);
    expect(usage.usage).toEqual({ usedBytes: 3072, totalBytes: 10240, expireAt: "2026-12-31T00:00:00.000Z" });
    expect(subscriptions.find(sub => sub.name === "No Usage")).toMatchObject({ nodeCount: 0, usage: null });
  });

  it("applies the node name filter on save and in listed node counts", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const hk = parseNodeLink("trojan://password@hk.example.com:443?sni=hk.example.com#HK 01");
    const expired = parseNodeLink("trojan://password@x.example.com:443?sni=x.example.com#剩余流量 1G");
    const save = (nodeNameFilter: unknown) => handleRequest(
      authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Filtered",
          yaml: "proxies: []\nrules: []\n",
          nodes: [hk, expired],
          config: { template: "minimal", nodeNameFilter },
        }),
      }),
      env
    );

    const unsafe = await save({ enabled: true, excludeRegexes: ["(\\w|\\d)+x$"] });
    expect(unsafe.status).toBe(400);
    expect(((await unsafe.json()) as { error: string }).error).toContain("自动处理规则无效");

    const excludesAll = await save({ enabled: true, excludeRegexes: ["."] });
    expect(excludesAll.status).toBe(400);
    expect(((await excludesAll.json()) as { error: string }).error).toContain("排除了全部节点");

    const created = await save({ enabled: true, excludeRegexes: ["剩余|过期"] });
    expect(created.status).toBe(200);
    const { subscription } = (await created.json()) as { subscription: { token: string } };
    const stored = JSON.parse(kv.values.get(`edge-config:${subscription.token}`)!) as { yaml: string };
    expect(stored.yaml).toContain("HK 01");
    expect(stored.yaml).not.toContain("剩余流量");

    const list = await handleRequest(authenticatedRequest("https://edge.test/api/subscriptions", cookie), env);
    const { subscriptions } = (await list.json()) as { subscriptions: Array<{ name: string; nodeCount: number }> };
    expect(subscriptions.find(sub => sub.name === "Filtered")?.nodeCount).toBe(1);
  });

  it("keeps relay groups pointing at renamed airport nodes after a scheduled refresh", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const airportYaml = (name: string) => [
      "proxies:",
      `  - { name: "${name}", type: trojan, server: hk.example.com, port: 443, password: secret, sni: hk.example.com }`,
    ].join("\n");
    let relayName = "香港 01";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(airportYaml(relayName), { headers: { "content-type": "text/yaml" } })));
    const vps = "vless://00000000-0000-4000-8000-000000000000@vps.example.com:443?encryption=none&security=tls#VPS";
    try {
      const createResponse = await handleRequest(
        authenticatedRequest("https://edge.test/api/subscriptions", cookie, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Relay",
            yaml: "proxies: []\nrules: []\n",
            autoUpdateInterval: 6 * 3600,
            urls: ["https://airport.example.com/sub"],
            nodes: [{ name: "香港 01", type: "trojan", server: "hk.example.com", port: 443, password: "secret", sni: "hk.example.com" }, parseNodeLink(vps)],
            config: {
              template: "minimal",
              sources: [
                { id: "airport", type: "url", content: "https://airport.example.com/sub" },
                { id: "vps", type: "nodes", content: vps },
              ],
              dialerProxyGroups: [
                { id: "relay", name: "香港中转", type: "select", relayNodes: ["香港 01"], targetNodes: ["VPS"] },
              ],
            },
          }),
        }),
        env
      );
      expect(createResponse.status).toBe(200);
      const { subscription } = (await createResponse.json()) as { subscription: { token: string; nextUpdateAt: string } };
      const runAt = (offsetHours: number) =>
        new Date(new Date(subscription.nextUpdateAt).getTime() + offsetHours * 3600_000 + 1000);

      // The first refresh records source ownership; the second sees the airport's rename.
      await runScheduledSubscriptionUpdates({ SUB_KV: kv }, runAt(0));
      relayName = "🇭🇰 香港 01";
      const summary = await runScheduledSubscriptionUpdates({ SUB_KV: kv }, runAt(6));
      const stored = JSON.parse(kv.values.get(`edge-config:${subscription.token}`)!) as {
        yaml: string;
        config: { dialerProxyGroups: Array<{ relayNodes: string[]; targetNodes: string[] }> };
      };

      expect(summary).toMatchObject({ updated: 1, failed: 0 });
      expect(stored.config.dialerProxyGroups[0]).toMatchObject({ relayNodes: ["🇭🇰 香港 01"], targetNodes: ["VPS"] });
      expect(stored.yaml).toContain("dialer-proxy: 香港中转");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the last successful YAML when a scheduled refresh fails", async () => {
    const kv = new MemoryKv();
    const env = createEnv(kv);
    const cookie = await login(env);
    const previousYaml = generateClashYaml(buildGenerateOptionsFromConfig({ template: "minimal" }, { nodes: [{ name: "Previous", type: "direct" } as never] }));
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

    // The dashboard needs the reason, otherwise a failing source looks healthy.
    const list = await handleRequest(authenticatedRequest("https://edge.test/api/subscriptions", cookie), env);
    const { subscriptions } = (await list.json()) as {
      subscriptions: Array<{ autoUpdateState: { lastError: string | null; lastFailedAt: string | null } }>;
    };
    expect(subscriptions[0].autoUpdateState.lastError).toBe(stored.lastError);
    expect(subscriptions[0].autoUpdateState.lastFailedAt).toBeTruthy();
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
