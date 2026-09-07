import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSubscriptionRecord, runScheduledSubscriptionUpdates } from "./edge-api";
import { handleRequest } from "./index";
import { resetStoredConfigCache } from "./stored-config-cache";
import type { ExecutionContextLike, KVNamespaceLike, WorkerEnv } from "./types";

type StoredValue = {
  version: 2;
  name: string;
  yaml: string;
  urls: string[];
  nodes: unknown[];
  config: Record<string, unknown>;
  conversionProfileId: "native";
  subscriptionInfo: Record<string, unknown>;
  autoUpdateInterval: number | null;
  createdAt: string;
  updatedAt: string;
  nextUpdateAt?: string;
};

class RaceKv implements KVNamespaceLike {
  readonly values = new Map<string, string>();
  readonly metadata = new Map<string, unknown>();
  migrationReadStarted!: () => void;
  readonly migrationRead: Promise<void>;
  releaseMigrationRead!: () => void;
  private getCount = 0;
  private blockSecondRead = false;

  constructor() {
    this.migrationRead = new Promise<void>((resolve) => {
      this.migrationReadStarted = resolve;
    });
    this.releaseMigrationRead = () => undefined;
  }

  holdSecondRead(): void {
    this.blockSecondRead = true;
    this.releaseMigrationRead = (() => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.readGateResolve?.();
      };
    })();
  }

  private readGateResolve?: () => void;

  async get(key: string): Promise<string | null> {
    this.getCount += 1;
    if (this.blockSecondRead && this.getCount === 2) {
      this.migrationReadStarted();
      await new Promise<void>((resolve) => {
        this.readGateResolve = resolve;
      });
    }
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string, options?: { metadata?: unknown }): Promise<void> {
    this.values.set(key, value);
    if (options?.metadata === undefined) this.metadata.delete(key);
    else this.metadata.set(key, options.metadata);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
    this.metadata.delete(key);
  }

  async list(options: { prefix?: string } = {}): Promise<{
    keys: Array<{ name: string; metadata?: unknown }>;
    list_complete: boolean;
  }> {
    return {
      keys: [...this.values.keys()]
        .filter((name) => !options.prefix || name.startsWith(options.prefix))
        .map((name) => ({ name, ...(this.metadata.has(name) ? { metadata: this.metadata.get(name) } : {}) })),
      list_complete: true,
    };
  }
}

function context(): ExecutionContextLike & { promises: Promise<unknown>[] } {
  const promises: Promise<unknown>[] = [];
  return { promises, waitUntil: (promise) => promises.push(promise) };
}

afterEach(() => {
  resetStoredConfigCache();
  vi.unstubAllGlobals();
});

describe("stored subscription KV races", () => {
  it("returns a controlled no-store response for malformed stored JSON", async () => {
    const kv = new RaceKv();
    const token = "c".repeat(20);
    kv.values.set(`edge-config:${token}`, "not-json");

    const get = await handleRequest(new Request(`https://edge.test/config/${token}`), { SUB_KV: kv });
    expect(get.status).toBe(500);
    expect(await get.text()).toBe("Stored subscription is invalid");
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");

    const head = await handleRequest(
      new Request(`https://edge.test/config/${token}`, { method: "HEAD" }),
      { SUB_KV: kv }
    );
    expect(head.status).toBe(500);
    expect(await head.text()).toBe("");
    expect(head.headers.get("cache-control")).toBe("no-store");
  });

  it("does not let legacy GET migration overwrite a newer value", async () => {
    const kv = new RaceKv();
    const token = "a".repeat(20);
    const key = `edge-config:${token}`;
    kv.values.set(
      key,
      JSON.stringify({
        version: 1,
        name: "Legacy",
        yaml: "proxies: []\n",
        createdAt: "2026-01-01T00:00:00.000Z",
      })
    );
    kv.holdSecondRead();
    const ctx = context();

    const response = await handleRequest(new Request(`https://edge.test/config/${token}`), { SUB_KV: kv }, ctx);
    expect(response.status).toBe(200);
    await kv.migrationRead;

    const newer = JSON.stringify({
      version: 2,
      name: "Newer",
      yaml: "proxies: [newer]\n",
      urls: [],
      nodes: [],
      config: {},
      conversionProfileId: "native",
      subscriptionInfo: {},
      autoUpdateInterval: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-09-07T00:00:00.000Z",
    });
    kv.values.set(key, newer);
    kv.releaseMigrationRead();
    await Promise.all(ctx.promises);

    expect(kv.values.get(key)).toBe(newer);
  });

  it("does not let a queued stale PUT resurrect a record deleted first", async () => {
    const kv = new RaceKv();
    const token = "d".repeat(20);
    const key = `edge-config:${token}`;
    const original: StoredValue = {
      version: 2,
      name: "Original",
      yaml: "proxies: []\n",
      urls: [],
      nodes: [],
      config: {},
      conversionProfileId: "native",
      subscriptionInfo: {},
      autoUpdateInterval: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const originalStored = JSON.stringify(original);
    kv.values.set(key, originalStored);
    kv.holdSecondRead();

    const deletePromise = handleSubscriptionRecord(
      new Request(`https://edge.test/api/subscriptions/${token}`, { method: "DELETE" }),
      { SUB_KV: kv }
    );
    await kv.migrationRead;

    const putPromise = handleSubscriptionRecord(
      new Request(`https://edge.test/api/subscriptions/${token}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Stale PUT", yaml: "proxies: [stale]\n" }),
      }),
      { SUB_KV: kv }
    );

    kv.releaseMigrationRead();
    const [deleted, put] = await Promise.all([deletePromise, putPromise]);
    expect(deleted.status).toBe(204);
    expect(put.status).toBe(409);
    expect(kv.values.has(key)).toBe(false);
  });

  it("skips a scheduled refresh when the source changes during refresh", async () => {
    const kv = new RaceKv();
    const token = "b".repeat(20);
    const key = `edge-config:${token}`;
    const original: StoredValue = {
      version: 2,
      name: "Scheduled",
      yaml: "proxies: []\n",
      urls: ["https://example.com/sub.yaml"],
      nodes: [],
      config: {
        template: "minimal",
        sources: [{ id: "source-1", type: "url", content: "https://example.com/sub.yaml" }],
      },
      conversionProfileId: "native",
      subscriptionInfo: {},
      autoUpdateInterval: 3600,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextUpdateAt: "2026-01-01T01:00:00.000Z",
    };
    const newer = JSON.stringify({ ...original, yaml: "proxies: [newer]\n", updatedAt: "2026-09-07T00:00:00.000Z" });
    kv.values.set(key, JSON.stringify(original));
    kv.metadata.set(key, { version: 1, autoUpdate: true, nextUpdateAt: original.nextUpdateAt });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        kv.values.set(key, newer);
        return new Response(
          "proxies:\n  - name: Remote\n    type: trojan\n    server: remote.example.com\n    port: 443\n    password: secret\n",
          { headers: { "content-type": "text/yaml" } }
        );
      })
    );

    const summary = await runScheduledSubscriptionUpdates(
      { SUB_KV: kv },
      new Date("2026-09-07T00:00:00.000Z")
    );

    expect(summary).toMatchObject({ scanned: 1, due: 1, updated: 0, skipped: 1 });
    expect(kv.values.get(key)).toBe(newer);
  });
});
