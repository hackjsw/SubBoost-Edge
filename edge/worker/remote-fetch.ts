import { readResponseTextWithLimit } from "@subboost/server-core/subscription/read-response-text";

type RemoteFetchOptions = {
  maxBytes: number;
  timeoutMs: number;
  userAgent: string;
  method?: "GET" | "HEAD";
  maxRedirects?: number;
  signal?: AbortSignal;
};

export type RemoteFetchResult = {
  content: string;
  headers: Record<string, string>;
  status: number;
  finalUrl: string;
};

function ipv4ToInt(hostname: string): number | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const bytes = parts.map(Number);
  if (bytes.some((part) => part > 255)) return null;
  return (((bytes[0] << 24) >>> 0) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
}

function ipv4InCidr(value: number, base: number, bits: number): boolean {
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (((value & mask) >>> 0) === ((base & mask) >>> 0));
}

function isBlockedIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const value = ipv4ToInt(hostname);
  // A dotted numeric host with an out-of-range octet is not a public target.
  if (value === null) return true;
  const blocked = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const;
  return blocked.some(([base, bits]) => {
    const baseValue = ipv4ToInt(base);
    return baseValue !== null && ipv4InCidr(value, baseValue, bits);
  });
}

function parseIpv6(hostname: string): number[] | null {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!value || value.includes("%")) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;

  const parsePart = (part: string): number[] | null => {
    if (!part) return [];
    const pieces = part.split(":");
    const out: number[] = [];
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      if (piece.includes(".")) {
        if (index !== pieces.length - 1) return null;
        const ipv4 = ipv4ToInt(piece);
        if (ipv4 === null) return null;
        out.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      out.push(Number.parseInt(piece, 16));
    }
    return out;
  };

  const left = parsePart(halves[0]);
  const right = parsePart(halves.length === 2 ? halves[1] : "");
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function isBlockedIpv6(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!value.includes(":")) return false;
  const groups = parseIpv6(value);
  if (!groups) return true;
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true; // documentation
  if (groups[0] === 0x2001 && groups[1] === 0x0002) return true; // benchmarking

  const isMapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const isCompat = groups.slice(0, 6).every((group) => group === 0);
  if (isMapped || isCompat) {
    const mapped = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isBlockedIpv4(mapped);
  }
  return false;
}

export function assertPublicHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("无效的订阅 URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("只支持 HTTP 或 HTTPS 订阅 URL");
  }
  if (url.username || url.password) {
    throw new Error("订阅 URL 不允许包含用户名或密码");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    isBlockedIpv4(hostname) ||
    isBlockedIpv6(hostname)
  ) {
    throw new Error("禁止访问本机或内网地址");
  }

  return url;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Body cleanup must not replace the useful fetch failure.
  }
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

export async function fetchRemoteText(
  input: string,
  options: RemoteFetchOptions,
  fetchImpl: typeof fetch = fetch
): Promise<RemoteFetchResult> {
  // Validate before allocating timers so rejected input cannot leave work
  // scheduled in the Worker event loop.
  let currentUrl = assertPublicHttpUrl(input).toString();
  const controller = new AbortController();
  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.floor(options.timeoutMs))
      : 15_000;
  const maxBytes =
    typeof options.maxBytes === "number" && Number.isFinite(options.maxBytes)
      ? Math.max(0, Math.floor(options.maxBytes))
      : 10 * 1024 * 1024;
  const maxRedirects =
    typeof options.maxRedirects === "number" && Number.isFinite(options.maxRedirects)
      ? Math.min(10, Math.max(0, Math.floor(options.maxRedirects)))
      : 3;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onCallerAbort = () => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const deadline = Date.now() + timeoutMs;

  const fetchWithDeadline = async (url: string): Promise<Response> => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0 || controller.signal.aborted) {
      throw new DOMException("The operation timed out", "AbortError");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<Response>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(abortError());
      }, Math.max(1, Math.ceil(remainingMs)));
    });
    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<Response>((_, reject) => {
      onAbort = () => reject(abortError());
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const fetchPromise = Promise.resolve().then(() =>
      fetchImpl(url, {
        method: options.method ?? "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": options.userAgent,
          Accept: "text/plain, application/yaml, application/x-yaml, */*;q=0.8",
          "Cache-Control": "no-cache",
        },
      })
    );
    fetchPromise.then((response) => {
      if (controller.signal.aborted) void cancelResponseBody(response);
    }, () => undefined);
    try {
      return await Promise.race([fetchPromise, timeoutPromise, abortPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    }
  };

  try {
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      assertPublicHttpUrl(currentUrl);
      const response = await fetchWithDeadline(currentUrl);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          await cancelResponseBody(response);
          throw new Error(`HTTP ${response.status}`);
        }
        if (redirectCount === maxRedirects) {
          await cancelResponseBody(response);
          throw new Error("订阅重定向次数过多");
        }
        await cancelResponseBody(response);
        try {
          currentUrl = new URL(location, currentUrl).toString();
        } catch {
          throw new Error("订阅重定向地址无效");
        }
        continue;
      }

      if (!response.ok) {
        await cancelResponseBody(response);
        throw new Error(`HTTP ${response.status}`);
      }
      const content =
        options.method === "HEAD"
          ? await (async () => {
              try {
                await response.body?.cancel();
              } catch {
                // Best-effort cleanup for HEAD responses.
              }
              return { ok: true as const, text: "" };
            })()
          : await readResponseTextWithLimit(response, maxBytes, controller.signal);
      if (!content.ok) throw new Error("订阅响应过大");

      return {
        content: content.text,
        headers: headersToRecord(response.headers),
        status: response.status,
        finalUrl: currentUrl,
      };
    }

    throw new Error("订阅重定向次数过多");
  } catch (error) {
    if (
      (error instanceof DOMException && error.name === "AbortError") ||
      (error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError") ||
      controller.signal.aborted
    ) {
      throw new Error("订阅请求超时");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}
