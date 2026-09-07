import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invalidateStoredConfigCache,
  loadStoredConfigResponse,
  resetStoredConfigCache,
  storedConfigCacheKey,
  STORED_CONFIG_CACHE_MAX_BODY_BYTES,
  STORED_CONFIG_CACHE_TTL_MS,
} from "./stored-config-cache";

function sizedResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-length", String(new TextEncoder().encode(body).byteLength));
  return new Response(body, { ...init, headers });
}

afterEach(() => {
  resetStoredConfigCache();
  vi.useRealTimers();
});

describe("stored config cache", () => {
  it("reuses a successful GET body until it expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T00:00:00.000Z"));
    const key = storedConfigCacheKey("aaaaaaaaaaaaaaaaaaaa", "GET", false);
    let loads = 0;

    const first = await loadStoredConfigResponse(key, { method: "GET" }, async () => {
      loads += 1;
      return sizedResponse("proxies: []\n", { headers: { "content-type": "text/yaml" } });
    });
    const second = await loadStoredConfigResponse(key, { method: "GET" }, async () => {
      loads += 1;
      return sizedResponse("proxies: [stale]\n");
    });

    expect(loads).toBe(1);
    expect(await first.text()).toBe("proxies: []\n");
    expect(await second.text()).toBe("proxies: []\n");
    expect(second.headers.get("content-type")).toBe("text/yaml");

    vi.advanceTimersByTime(STORED_CONFIG_CACHE_TTL_MS + 1);
    const third = await loadStoredConfigResponse(key, { method: "GET" }, async () => {
      loads += 1;
      return sizedResponse("proxies: [fresh]\n");
    });
    expect(loads).toBe(2);
    expect(await third.text()).toBe("proxies: [fresh]\n");
  });

  it("does not cache failures and invalidates a token", async () => {
    const key = storedConfigCacheKey("bbbbbbbbbbbbbbbbbbbb", "GET", true);
    let loads = 0;
    const missing = await loadStoredConfigResponse(key, { method: "GET" }, async () => {
      loads += 1;
      return new Response("Subscription not found", { status: 404 });
    });
    const found = await loadStoredConfigResponse(key, { method: "GET" }, async () => {
      loads += 1;
      return sizedResponse("proxies: []\n");
    });

    expect(missing.status).toBe(404);
    expect(await found.text()).toBe("proxies: []\n");
    expect(loads).toBe(2);

    invalidateStoredConfigCache("bbbbbbbbbbbbbbbbbbbb");
    const afterInvalidate = await loadStoredConfigResponse(key, { method: "GET" }, async () => {
      loads += 1;
      return sizedResponse("proxies: [next]\n");
    });
    expect(loads).toBe(3);
    expect(await afterInvalidate.text()).toBe("proxies: [next]\n");
  });

  it("collapses concurrent loads into one fetch", async () => {
    const key = storedConfigCacheKey("cccccccccccccccccccc", "GET", false);
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const loader = async () => {
      loads += 1;
      await gate;
      return sizedResponse("proxies: []\n");
    };

    const pending = [
      loadStoredConfigResponse(key, { method: "GET" }, loader),
      loadStoredConfigResponse(key, { method: "GET" }, loader),
    ];
    release();
    const bodies = await Promise.all(pending);
    expect(loads).toBe(1);
    expect(await bodies[0].text()).toBe("proxies: []\n");
    expect(await bodies[1].text()).toBe("proxies: []\n");
  });

  it("does not let an invalidated in-flight read repopulate stale data", async () => {
    const token = "dddddddddddddddddddd";
    const key = storedConfigCacheKey(token, "GET", false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const stale = loadStoredConfigResponse(key, { method: "GET" }, async () => {
      await gate;
      return sizedResponse("stale");
    });
    invalidateStoredConfigCache(token);

    const fresh = await loadStoredConfigResponse(key, { method: "GET" }, async () =>
      sizedResponse("fresh")
    );
    release();

    expect(await fresh.text()).toBe("fresh");
    expect(await (await stale).text()).toBe("stale");
    const cached = await loadStoredConfigResponse(key, { method: "GET" }, async () =>
      sizedResponse("unexpected")
    );
    expect(await cached.text()).toBe("fresh");
  });

  it("drops a rejected in-flight read so a later request can retry", async () => {
    const key = storedConfigCacheKey("11111111111111111111", "GET", false);
    let loads = 0;
    const first = loadStoredConfigResponse(key, { method: "GET" }, async () => {
      loads += 1;
      throw new Error("upstream unavailable");
    });

    await expect(first).rejects.toThrow("upstream unavailable");

    const second = await loadStoredConfigResponse(key, { method: "GET" }, async () => {
      loads += 1;
      return sizedResponse("retry succeeded");
    });
    expect(loads).toBe(2);
    expect(await second.text()).toBe("retry succeeded");
  });

  it("does not let reset make an old in-flight generation cacheable", async () => {
    const key = storedConfigCacheKey("22222222222222222222", "GET", false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const stale = loadStoredConfigResponse(key, { method: "GET" }, async () => {
      await gate;
      return sizedResponse("before reset");
    });
    resetStoredConfigCache();
    release();
    expect(await (await stale).text()).toBe("before reset");

    const fresh = await loadStoredConfigResponse(key, { method: "GET" }, async () =>
      sizedResponse("after reset")
    );
    expect(await fresh.text()).toBe("after reset");
  });

  it("does not consume oversized or unsuccessful bodies inside the cache", async () => {
    const oversizedKey = storedConfigCacheKey("eeeeeeeeeeeeeeeeeeee", "GET", false);
    const oversized = new Response("large", {
      headers: { "content-length": String(STORED_CONFIG_CACHE_MAX_BODY_BYTES + 1) },
    });
    const oversizedResult = await loadStoredConfigResponse(
      oversizedKey,
      { method: "GET" },
      async () => oversized
    );
    expect(oversized.bodyUsed).toBe(false);
    expect(await oversizedResult.text()).toBe("large");

    const failureKey = storedConfigCacheKey("ffffffffffffffffffff", "GET", false);
    const failure = new Response("failed", { status: 502 });
    const failureResult = await loadStoredConfigResponse(
      failureKey,
      { method: "GET" },
      async () => failure
    );
    expect(failure.bodyUsed).toBe(false);
    expect(await failureResult.text()).toBe("failed");
  });

  it("bounds inspection of an unknown-length oversized stream and preserves it for the caller", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(STORED_CONFIG_CACHE_MAX_BODY_BYTES + 1));
          controller.close();
        },
        cancel,
      })
    );
    const key = storedConfigCacheKey("33333333333333333333", "GET", false);

    const result = await loadStoredConfigResponse(key, { method: "GET" }, async () => response);

    expect(response.bodyUsed).toBe(false);
    expect(pulls).toBe(1);
    expect((await result.arrayBuffer()).byteLength).toBe(STORED_CONFIG_CACHE_MAX_BODY_BYTES + 1);
    expect(cancel).not.toHaveBeenCalled();
  });
});
