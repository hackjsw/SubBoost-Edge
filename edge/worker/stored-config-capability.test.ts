import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStoredConfigCapability,
  handleStoredConfigCapability,
  openStoredConfigCapability,
  STORED_CONFIG_CAPABILITY_TTL_SECONDS,
} from "./stored-config-capability";
import type { WorkerEnv } from "./types";

const env: WorkerEnv = { EDGE_SESSION_SECRET: "capability-test-secret" };
const capability = { token: "a".repeat(20), revision: "b".repeat(32) };

afterEach(() => {
  vi.useRealTimers();
});

describe("stored config capability", () => {
  it("seals the token into a stable URL without touching storage", async () => {
    const now = Date.parse("2026-10-01T00:00:10.000Z");
    const url = await createStoredConfigCapability(env, "https://edge.test/config/token", capability, now);

    expect(url).toMatch(/^https:\/\/edge\.test\/config-cap\/[A-Za-z0-9_-]+$/);
    expect(url).not.toContain(capability.token);
    expect(url).not.toContain(capability.revision);
    // Same revision within one window keeps one URL so converter caches hit.
    expect(await createStoredConfigCapability(env, "https://edge.test/x", capability, now + 60_000)).toBe(url);
    expect(
      await createStoredConfigCapability(env, "https://edge.test/x", { ...capability, revision: "c".repeat(32) }, now)
    ).not.toBe(url);
    expect(await openStoredConfigCapability(env, new URL(url).pathname, now)).toEqual(capability);
  });

  it("serves GET/HEAD with no-store semantics through the resolver", async () => {
    const url = await createStoredConfigCapability(env, "https://edge.test/config/token", capability);
    const resolve = vi.fn(async () => "proxies: []\n");

    const get = await handleStoredConfigCapability(new Request(url), env, resolve);
    expect(get.status).toBe(200);
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(get.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await get.text()).toBe("proxies: []\n");
    expect(resolve).toHaveBeenCalledWith(capability);

    const head = await handleStoredConfigCapability(new Request(url, { method: "HEAD" }), env, resolve);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe(String(new TextEncoder().encode("proxies: []\n").byteLength));
  });

  it("rejects tampered, foreign, and expired capabilities", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T00:00:00.000Z"));
    const url = await createStoredConfigCapability(env, "https://edge.test/config/token", capability);
    const sealed = new URL(url).pathname.split("/").at(-1)!;
    const resolve = async () => "proxies: []\n";

    const tampered = sealed.slice(0, -2) + (sealed.endsWith("AA") ? "BB" : "AA");
    expect((await handleStoredConfigCapability(new Request(`https://edge.test/config-cap/${tampered}`), env, resolve)).status).toBe(404);
    expect((await handleStoredConfigCapability(new Request(`${url}/nested`), env, resolve)).status).toBe(404);
    expect((await handleStoredConfigCapability(new Request(url), { EDGE_SESSION_SECRET: "other" }, resolve)).status).toBe(404);
    expect((await handleStoredConfigCapability(new Request(`${url}?x=1`), env, resolve)).status).toBe(200);

    vi.advanceTimersByTime(2 * STORED_CONFIG_CAPABILITY_TTL_SECONDS * 1000 + 1);
    expect((await handleStoredConfigCapability(new Request(url), env, resolve)).status).toBe(404);
  });

  it("does not expose resolver errors or accept non-read methods", async () => {
    const url = await createStoredConfigCapability(env, "https://edge.test/config/token", capability);
    const failed = await handleStoredConfigCapability(new Request(url), env, async () => {
      throw new Error("internal storage details");
    });
    expect(failed.status).toBe(404);
    expect(await failed.text()).not.toContain("internal storage details");

    const gone = await handleStoredConfigCapability(new Request(url), env, async () => null);
    expect(gone.status).toBe(404);

    const method = await handleStoredConfigCapability(new Request(url, { method: "POST" }), env, async () => "");
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET, HEAD");
  });
});
