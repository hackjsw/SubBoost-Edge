import { describe, expect, it, vi } from "vitest";
import { assertPublicHttpUrl, fetchRemoteText } from "./remote-fetch";

const OPTIONS = {
  maxBytes: 1024,
  timeoutMs: 1000,
  userAgent: "EdgeSub Test",
};

describe("Edge remote fetch", () => {
  it("rejects local and credentialed targets before fetch", async () => {
    expect(() => assertPublicHttpUrl("http://127.0.0.1/sub")).toThrow("禁止访问本机或内网地址");
    expect(() => assertPublicHttpUrl("http://localhost./sub")).toThrow("禁止访问本机或内网地址");
    expect(() => assertPublicHttpUrl("http://service.internal./sub")).toThrow("禁止访问本机或内网地址");
    expect(() => assertPublicHttpUrl("https://user:pass@example.com/sub")).toThrow(
      "订阅 URL 不允许包含用户名或密码"
    );
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchRemoteText("http://localhost/sub", OPTIONS, fetchImpl)).rejects.toThrow(
      "禁止访问本机或内网地址"
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks reserved IPv4/IPv6 targets and malformed IPv6 literals", () => {
    for (const url of [
      "http://192.88.99.1/sub",
      "http://203.0.113.1/sub",
      "http://[2001:2::1]/sub",
      "http://[::ffff:192.168.1.1]/sub",
    ]) {
      expect(() => assertPublicHttpUrl(url)).toThrow("禁止访问本机或内网地址");
    }
    expect(() => assertPublicHttpUrl("http://[2001:db8:::1]/sub")).toThrow("无效的订阅 URL");
  });

  it("cancels redirect bodies and validates the next target", async () => {
    const redirect = new Response("redirect", {
      status: 302,
      headers: { location: "https://example.net/final" },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect)
      .mockResolvedValueOnce(new Response("ss://node", { status: 200 }));

    await expect(fetchRemoteText("https://example.com/start", OPTIONS, fetchImpl)).resolves.toMatchObject({
      content: "ss://node",
      finalUrl: "https://example.net/final",
    });
    expect(redirect.bodyUsed).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops reading and cancels a streamed body once the byte limit is exceeded", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(700));
        },
        cancel,
      }),
      { status: 200 }
    );
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(fetchRemoteText("https://example.com/sub", OPTIONS, fetchImpl)).rejects.toThrow(
      "订阅响应过大"
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it("honors a caller abort even when the fetch implementation ignores the signal", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const pending = fetchRemoteText(
      "https://example.com/sub",
      { ...OPTIONS, signal: controller.signal },
      fetchImpl
    );

    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toThrow("订阅请求超时");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("cancels the body for successful HEAD responses", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({ cancel }),
      { status: 200 }
    );
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(
      fetchRemoteText("https://example.com/userinfo", { ...OPTIONS, method: "HEAD" }, fetchImpl)
    ).resolves.toMatchObject({ content: "" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
