// Cloudflare Workers outbound TCP sockets.
export async function measureTcpConnectivity(hostname: string, port: number, timeoutMs: number): Promise<number> {
  let socket: { opened: Promise<unknown>; close(): void };
  try {
    // @ts-expect-error The module is provided by the Workers runtime.
    const { connect } = await import("cloudflare:sockets");
    socket = connect({ hostname, port });
  } catch {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await fetch(`http://${hostname}:${port}/`, { method: "HEAD", signal: controller.signal });
      return Date.now();
    } finally {
      clearTimeout(timer);
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      socket.opened,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("TCP connection timed out")), timeoutMs);
      }),
    ]);
    return Date.now();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      socket.close();
    } catch {
      // Best-effort cleanup after a failed connection.
    }
  }
}
