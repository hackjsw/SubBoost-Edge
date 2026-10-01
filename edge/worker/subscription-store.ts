import type { DurableObjectNamespaceLike, WorkerEnv } from "./types";

interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: (string | number | null)[]): { toArray(): T[] };
}

export interface SubscriptionStoreState {
  storage: {
    sql: SqlStorage;
    transactionSync<T>(callback: () => T): T;
    setAlarm(time: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

type StoredState = { token: string; present: number; revision: string; metadata: string; dirty: number };

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

// Each token has one authoritative object. KV remains the discovery index and
// backup; a durable tombstone prevents a stale KV read from resurrecting deletes.
export class SubscriptionStore {
  constructor(private state: SubscriptionStoreState, private env: WorkerEnv) {
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS subscription_state (id INTEGER PRIMARY KEY, token TEXT, present INTEGER, revision TEXT, metadata TEXT, dirty INTEGER)");
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS subscription_chunks (part INTEGER PRIMARY KEY, content TEXT)");
  }

  private current(): StoredState | undefined {
    return this.state.storage.sql.exec<StoredState>("SELECT * FROM subscription_state WHERE id = 1").toArray()[0];
  }

  private value(): string {
    return this.state.storage.sql.exec<{ content: string }>("SELECT content FROM subscription_chunks ORDER BY part").toArray().map(row => row.content).join("");
  }

  private save(token: string, value: string | null, revision: string, metadata: unknown, dirty: boolean): void {
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec("DELETE FROM subscription_chunks");
      // Keep each SQLite row below its size limit, including multibyte names.
      for (let offset = 0, part = 0; value && offset < value.length; part++) {
        let end = Math.min(offset + 65536, value.length);
        if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
        this.state.storage.sql.exec("INSERT INTO subscription_chunks VALUES (?, ?)", part, value.slice(offset, end));
        offset = end;
      }
      this.state.storage.sql.exec("INSERT OR REPLACE INTO subscription_state VALUES (1, ?, ?, ?, ?, ?)",
        token, value === null ? 0 : 1, revision, JSON.stringify(metadata ?? null), dirty ? 1 : 0);
    });
  }

  private async mirror(): Promise<void> {
    const current = this.current();
    if (!current?.dirty) return;
    if (!this.env.SUB_KV) throw new Error("KV is not configured");
    const key = `edge-config:${current.token}`;
    if (current.present) await this.env.SUB_KV.put(key, this.value(), { metadata: JSON.parse(current.metadata) });
    else await this.env.SUB_KV.delete(key);
    this.state.storage.sql.exec("UPDATE subscription_state SET dirty = 0 WHERE id = 1");
    await this.state.storage.deleteAlarm();
  }

  async fetch(request: Request): Promise<Response> {
    const token = new URL(request.url).pathname.slice(1);
    if (!/^[a-f0-9]{20}$/.test(token)) return new Response("Invalid token", { status: 400 });
    if (request.method !== "GET" && request.method !== "PUT") return new Response(null, { status: 405 });
    const mutation = request.method === "PUT"
      ? await request.json() as { expected: string | null; value: string | null; metadata?: unknown }
      : null;
    return this.state.blockConcurrencyWhile(async () => {
      let current = this.current();
      if (!current) {
        if (!this.env.SUB_KV) return new Response("KV is not configured", { status: 503 });
        const value = await this.env.SUB_KV.get(`edge-config:${token}`);
        // A KV miss can be temporary during legacy migration. Only an actual
        // DELETE creates a durable tombstone; do not persist negative reads.
        if (value === null && !mutation) return new Response(null, { status: 404 });
        this.save(token, value, value === null ? "" : await hash(value), null, false);
        current = this.current()!;
      }
      if (current.token !== token) return new Response("Token mismatch", { status: 400 });
      if (!mutation) {
        return new Response(current.present ? this.value() : null, {
          status: current.present ? 200 : 404,
          headers: { ETag: current.revision, "Cache-Control": "no-store" },
        });
      }
      if (mutation.expected !== (current.present ? current.revision : null)) return new Response(null, { status: 409 });
      const revision = mutation.value === null ? "" : await hash(mutation.value);
      // An identical, already-mirrored write would only burn a KV write.
      if (
        mutation.value !== null &&
        !current.dirty &&
        current.present === 1 &&
        current.revision === revision &&
        current.metadata === JSON.stringify(mutation.metadata ?? null)
      ) {
        return new Response(null, { status: 204 });
      }
      // Schedule before committing so a crash cannot leave the KV index unrepaired.
      await this.state.storage.setAlarm(Date.now() + 30_000);
      this.save(token, mutation.value, revision, mutation.metadata, true);
      try { await this.mirror(); } catch { /* The alarm retries the durable pending mirror. */ }
      return new Response(null, { status: 204 });
    });
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      await this.state.storage.setAlarm(Date.now() + 60_000);
      await this.mirror();
      await this.state.storage.deleteAlarm();
    });
  }
}

export async function readStoredValue(env: WorkerEnv, token: string): Promise<{ value: string | null; revision?: string }> {
  if (!env.SUB_STORE) return { value: await env.SUB_KV!.get(`edge-config:${token}`) };
  const namespace: DurableObjectNamespaceLike = env.SUB_STORE;
  const response = await namespace.get(namespace.idFromName(token)).fetch(new Request(`https://subscription/${token}`));
  if (response.status === 404) return { value: null };
  if (!response.ok) throw new Error("Subscription storage is unavailable");
  return { value: await response.text(), revision: response.headers.get("etag") ?? undefined };
}

export async function writeStoredValue(env: WorkerEnv, token: string, expected: string | null, value: string | null, metadata?: unknown): Promise<boolean> {
  const namespace: DurableObjectNamespaceLike = env.SUB_STORE!;
  const response = await namespace.get(namespace.idFromName(token)).fetch(new Request(`https://subscription/${token}`, {
    method: "PUT",
    body: JSON.stringify({ expected: expected === null ? null : await hash(expected), value, metadata }),
  }));
  if (response.status === 409) return false;
  if (!response.ok) throw new Error("Subscription storage is unavailable");
  return true;
}
