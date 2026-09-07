import { describe, expect, it, vi } from "vitest";
import { readResponseTextWithLimit } from "./read-response-text";

describe("readResponseTextWithLimit", () => {
  it("decodes a streamed response within the byte limit", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("节"));
          controller.enqueue(new TextEncoder().encode("点"));
          controller.close();
        },
      })
    );

    await expect(readResponseTextWithLimit(response, 6)).resolves.toEqual({
      ok: true,
      text: "节点",
    });
  });

  it("cancels a streamed response as soon as the byte limit is exceeded", async () => {
    const cancel = vi.fn();
    let pullCount = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pullCount += 1;
          controller.enqueue(new Uint8Array(700));
        },
        cancel,
      })
    );

    await expect(readResponseTextWithLimit(response, 1024)).resolves.toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(pullCount).toBeLessThanOrEqual(2);
  });

  it("rejects an oversized declared length without consuming the body", async () => {
    const response = new Response("small", { headers: { "content-length": "2048" } });
    await expect(readResponseTextWithLimit(response, 1024)).resolves.toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(response.bodyUsed).toBe(true);
  });

  it("cancels a pending reader and rejects when the caller aborts", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel,
      })
    );
    const controller = new AbortController();
    const pending = readResponseTextWithLimit(response, 1024, controller.signal);

    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
