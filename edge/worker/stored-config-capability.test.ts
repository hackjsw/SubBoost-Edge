import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStoredConfigCapability,
  handleStoredConfigCapability,
  STORED_CONFIG_CAPABILITY_TTL_SECONDS,
} from "./stored-config-capability";
import type { KVNamespaceLike, WorkerEnv } from "./types";

class CapabilityKv implements KVNamespaceLike {
  readonly values = new Map<string, string>();
  readonly writes: Array<{ key: string; expirationTtl?: number }> = [];

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.values.set(key, value);
    this.writes.push({ key, ...(options?.expirationTtl === undefined ? {} : { expirationTtl: options.expirationTtl }) });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(): Promise<{ keys: Array<{ name: string }>; list_complete: boolean }> {
    return { keys: [], list_complete: true };
  }
}

const envFor = (kv: KVNamespaceLike): WorkerEnv => ({ SUB_KV: kv });

afterEach(() => {
  vi.useRealTimers();
});

describe("stored config capability", () => {
  it("stores an expiring opaque record and serves GET/HEAD with no-store semantics", async () => {
    const kv = new CapabilityKv();
    const env = envFor(kv);
    const url = await createStoredConfigCapability(env, "https://edge.test/config/token", "proxies: []\n");

    expect(url).toMatch(/^https:\/\/edge\.test\/config-cap\/[a-f0-9]{32}$/);
    expect(kv.writes).toEqual([
      {
        key: expect.stringMatching(/^edge-config-capability:v1:[a-f0-9]{32}$/),
        expirationTtl: STORED_CONFIG_CAPABILITY_TTL_SECONDS,
      },
    ]);

    const get = await handleStoredConfigCapability(new Request(url), env);
    expect(get.status).toBe(200);
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(get.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await get.text()).toBe("proxies: []\n");

    const head = await handleStoredConfigCapability(new Request(url, { method: "HEAD" }), env);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe(String(new TextEncoder().encode("proxies: []\n").byteLength));
  });

  it("rejects malformed paths and expired capability records", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T00:00:00.000Z"));
    const kv = new CapabilityKv();
    const env = envFor(kv);
    const url = await createStoredConfigCapability(env, "https://edge.test/config/token", "proxies: []\n");
    const token = new URL(url).pathname.split("/").at(-1);

    expect(
      (await handleStoredConfigCapability(new Request(`${url}/nested`), env)).status
    ).toBe(404);
    expect(
      (await handleStoredConfigCapability(new Request(`https://edge.test/config-cap/${token}?x=1`), env)).status
    ).toBe(200);

    vi.advanceTimersByTime((STORED_CONFIG_CAPABILITY_TTL_SECONDS + 1) * 1000);
    expect((await handleStoredConfigCapability(new Request(url), env)).status).toBe(404);
  });

  it("does not expose KV errors or accept non-read methods", async () => {
    const kv: KVNamespaceLike = {
      async get() {
        throw new Error("internal KV details");
      },
      async put() {},
      async delete() {},
      async list() {
        return { keys: [], list_complete: true };
      },
    };
    const url = "https://edge.test/config-cap/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const failed = await handleStoredConfigCapability(new Request(url), envFor(kv));
    expect(failed.status).toBe(404);
    expect(await failed.text()).not.toContain("internal KV details");

    const method = await handleStoredConfigCapability(new Request(url, { method: "POST" }), envFor(kv));
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET, HEAD");
  });
});
