export type LimitedResponseText =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" };

function declaredBodySize(response: Response): number | null {
  const value = response.headers.get("content-length");
  if (!value) return null;
  const values = value.split(",").map((item) => item.trim());
  if (values.length === 0 || values.some((item) => !/^\d+$/.test(item))) return null;
  const parsed = values.map(Number);
  if (parsed.some((item) => !Number.isSafeInteger(item))) return null;
  // Multiple Content-Length headers are valid only when they agree. If they
  // do not, ignore the hint and enforce the limit while streaming instead.
  return parsed.every((item) => item === parsed[0]) ? parsed[0] : null;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

export async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal
): Promise<LimitedResponseText> {
  const limit =
    typeof maxBytes === "number" && Number.isFinite(maxBytes)
      ? Math.max(0, Math.floor(maxBytes))
      : 0;
  if (signal?.aborted) {
    try {
      await response.body?.cancel();
    } catch {
      // Preserve the abort as the useful result.
    }
    throw abortError();
  }

  const declaredSize = declaredBodySize(response);
  if (declaredSize !== null && declaredSize > limit) {
    try {
      await response.body?.cancel();
    } catch {
      // The declared size is already enough to reject the response.
    }
    return { ok: false, reason: "too_large" };
  }

  if (!response.body) return { ok: true, text: "" };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (aborted || signal?.aborted) {
        throw abortError();
      }
      if (chunk.done) {
        text += decoder.decode();
        return { ok: true, text };
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > limit) {
        try {
          await reader.cancel();
        } catch {
          // The limit result is more useful than a cancellation error.
        }
        return { ok: false, reason: "too_large" };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    if (aborted || signal?.aborted) throw abortError();
    if (!aborted && !signal?.aborted) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the original stream error.
      }
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
