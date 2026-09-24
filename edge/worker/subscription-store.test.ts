import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import * as miniflare from "miniflare";
import path from "node:path";
import type { KVNamespaceLike } from "./types";

type TestNamespace = { idFromName(name: string): unknown; get(id: unknown): { fetch: typeof fetch } };

describe("subscription storage in the Workers runtime", () => {
  let runtime: miniflare.Miniflare;
  beforeAll(async () => {
    const bundled = await build({
      entryPoints: [path.resolve("edge/worker/index.ts")],
      tsconfig: path.resolve("edge/tsconfig.json"),
      bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:sockets"],
    });
    const options = {
      workers: [{ name: "edge",
      modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-02-07",
      kvNamespaces: ["SUB_KV"],
      durableObjects: { SUB_STORE: { className: "SubscriptionStore", useSQLite: true } },
      }],
    };
    // v4 accepts these options directly; v5 exposes a compatibility converter.
    const convert = (miniflare as unknown as { convertV4MiniflareOptions?: (value: unknown) => unknown }).convertV4MiniflareOptions;
    runtime = new miniflare.Miniflare((convert ? convert(options) : options) as ConstructorParameters<typeof miniflare.Miniflare>[0]);
    await runtime.ready;
  }, 30_000);
  afterAll(async () => { await runtime?.dispose(); });

  it("imports legacy data, rejects concurrent stale writes, and invalidates public cache by revision", async () => {
    const kv = await runtime.getKVNamespace("SUB_KV") as unknown as KVNamespaceLike;
    const namespace = await runtime.getDurableObjectNamespace("SUB_STORE") as unknown as TestNamespace;
    const token = "a".repeat(20);
    const stub = namespace.get(namespace.idFromName(token));
    const url = `https://subscription/${token}`;
    const legacy = JSON.stringify({ version: 2, name: "Original", yaml: "proxies: []\n# original", conversionProfileId: "native" });
    await kv.put(`edge-config:${token}`, legacy);
    const first = await runtime.dispatchFetch(`https://edge.test/config/${token}`);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("original");
    const original = await stub.fetch(url);
    const expected = original.headers.get("etag");
    const updated = JSON.stringify({ version: 2, name: "Updated", yaml: "proxies: []\n# updated", conversionProfileId: "native" });
    const writes = await Promise.all([updated, updated.replaceAll("updated", "other")].map(value => stub.fetch(url, {
      method: "PUT", body: JSON.stringify({ expected, value, metadata: { autoUpdate: false } }),
    })));
    expect(writes.map(response => response.status).sort()).toEqual([204, 409]);
    const authoritative = await stub.fetch(url);
    const revision = authoritative.headers.get("etag");
    const current = await authoritative.text();
    const yaml = (JSON.parse(current) as { yaml: string }).yaml;
    const next = await runtime.dispatchFetch(`https://edge.test/config/${token}`);
    expect(await next.text()).toBe(yaml);
    expect(await kv.get(`edge-config:${token}`)).toBe(current);
    expect((await stub.fetch(url, { method: "PUT", body: JSON.stringify({ expected: revision, value: null }) })).status).toBe(204);
    await kv.put(`edge-config:${token}`, legacy); // Simulate a stale KV replica.
    expect((await runtime.dispatchFetch(`https://edge.test/config/${token}`)).status).toBe(404);
    expect((await stub.fetch(url, { method: "PUT", body: JSON.stringify({ expected, value: legacy }) })).status).toBe(409);
  });

  it("does not turn a transient legacy KV miss into a permanent tombstone", async () => {
    const kv = await runtime.getKVNamespace("SUB_KV") as unknown as KVNamespaceLike;
    const namespace = await runtime.getDurableObjectNamespace("SUB_STORE") as unknown as TestNamespace;
    const token = "b".repeat(20);
    const stub = namespace.get(namespace.idFromName(token));
    const url = `https://subscription/${token}`;
    expect((await stub.fetch(url)).status).toBe(404);
    await kv.put(`edge-config:${token}`, "later-visible-value");
    expect(await (await stub.fetch(url)).text()).toBe("later-visible-value");
  });

  it("preserves large Unicode records across SQLite chunks", async () => {
    const namespace = await runtime.getDurableObjectNamespace("SUB_STORE") as unknown as TestNamespace;
    const token = "c".repeat(20);
    const stub = namespace.get(namespace.idFromName(token));
    const value = "x".repeat(65535) + "🚴鹈鹕".repeat(300_000);
    const url = `https://subscription/${token}`;
    expect((await stub.fetch(url, { method: "PUT", body: JSON.stringify({ expected: null, value }) })).status).toBe(204);
    expect(await (await stub.fetch(url)).text()).toBe(value);
  });
});
