import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dump, load } from "js-yaml";

const generated = dump({
  proxies: [{ name: "Probe", type: "trojan", server: "example.com", port: 443, password: "placeholder" }],
  "proxy-groups": [{ name: "Ai平台", type: "select", proxies: ["Probe", "DIRECT"] }],
  rules: ["DOMAIN-SUFFIX,openai.com,Ai平台", "MATCH,DIRECT"],
});
const options = {
  env: { SUBCONVERTER_BACKEND: "https://primary.test/sub", SUBCONVERTER_FALLBACK_BACKENDS: "https://backup.test/sub" },
  sourceUrl: "https://edge.test/config-cap/temporary",
  configUrl: "https://example.com/AI.ini",
};

describe("subconverter failover", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it.each([502, 403, 400, "html", "empty", "invalid-yaml"])("switches on %s and skips a failed backend during cooldown", async (failure) => {
    const { convertClashSubscription } = await import("./subconverter");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(typeof failure === "number"
        ? new Response("failed", { status: failure })
        : new Response(failure === "html" ? "<html>challenge</html>" : failure === "empty" ? "proxies: []\nrules: []" : "proxies: ["))
      .mockImplementation(async () => new Response(generated));
    vi.stubGlobal("fetch", fetchImpl);
    const response = await convertClashSubscription(options);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-subboost-converter")).toBe("backup.test");
    expect(await response.text()).toContain("openai.com");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get("config")).toBe(options.configUrl);
    await convertClashSubscription(options);
    expect(new URL(fetchImpl.mock.calls[2][0]).hostname).toBe("backup.test");
  });

  it("bounds body stalls with a timeout and then tries the backup", async () => {
    vi.useFakeTimers();
    const { convertClashSubscription } = await import("./subconverter");
    const cancel = vi.fn();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel })))
      .mockResolvedValueOnce(new Response(generated));
    vi.stubGlobal("fetch", fetchImpl);
    const pending = convertClashSubscription(options);
    await vi.advanceTimersByTimeAsync(8000);
    expect((await pending).status).toBe(200);
    expect(cancel).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("validates HEAD through GET and does not call the backup after success", async () => {
    const { convertClashSubscription } = await import("./subconverter");
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(generated));
    vi.stubGlobal("fetch", fetchImpl);
    const response = await convertClashSubscription({ ...options, method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "GET" });
  });

  it("reports all-backend failure without caching the error or returning native rules", async () => {
    const { convertClashSubscription } = await import("./subconverter");
    const fetchImpl = vi.fn(async () => { throw new Error("network"); });
    vi.stubGlobal("fetch", fetchImpl);
    const response = await convertClashSubscription(options);
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.text()).not.toContain(options.sourceUrl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("only exposes placeholder nodes and restores VLESS/XHTTP/ECH unchanged", async () => {
    const { convertClashSubscription, prepareClashTemplateSource } = await import("./subconverter");
    const original = { name: "Probe", type: "vless", server: "private-node.example", port: 443,
      uuid: "private-uuid", network: "xhttp", "xhttp-opts": { path: "/private-path", mode: "stream-one" },
      "ech-opts": { enable: true } };
    const prepared = prepareClashTemplateSource(dump({ proxies: [original] }));
    expect(prepared.yaml).not.toContain(original.uuid);
    expect(prepared.yaml).not.toContain(original.server);
    expect(prepared.yaml).toContain("template-placeholder");
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(generated));
    vi.stubGlobal("fetch", fetchImpl);
    const response = await convertClashSubscription({ ...options, originalProxies: prepared.proxies });
    const result = load(await response.text()) as { proxies: unknown[]; rules: string[] };
    expect(result.proxies).toEqual([original]);
    expect(result.rules).toContain("DOMAIN-SUFFIX,openai.com,Ai平台");
    expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get("emoji")).toBe("false");
  });

  it("rejects backends that rename or drop nodes before restoring placeholders", async () => {
    const { convertClashSubscription } = await import("./subconverter");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(generated.replaceAll("Probe", "Renamed")))
      .mockResolvedValueOnce(new Response(generated));
    vi.stubGlobal("fetch", fetchImpl);
    const response = await convertClashSubscription({ ...options, originalProxies: [{ name: "Probe", type: "vless" }] });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-subboost-converter")).toBe("backup.test");
  });
});
