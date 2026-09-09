export interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    keys: Array<{ name: string; metadata?: unknown }>;
    list_complete: boolean;
    cursor?: string;
  }>;
  delete(key: string): Promise<void>;
}

export interface AssetFetcherLike {
  fetch(request: Request): Promise<Response>;
}

export interface WorkerEnv {
  SUB_KV?: KVNamespaceLike;
  ASSETS?: AssetFetcherLike;
  EDGE_ADMIN_PASSWORD?: string;
  EDGE_SESSION_SECRET?: string;
  GITHUB_TOKEN?: string;
  SUBCONVERTER_BACKEND?: string;
  SUBCONVERTER_FALLBACK_BACKENDS?: string;
  ACL4SSR_CONFIG_URL?: string;
  CRON_SECRET?: string;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ScheduledControllerLike {
  scheduledTime: number;
  cron: string;
}

export interface EdgeNode {
  ip: string;
  port: string;
  name: string;
  region: string;
  link: string;
  protocol: string;
}

export interface SubRequestParams {
  id: string;
  template: string;
  source: string;
  profile?: string;
  rawMode: boolean;
  jsonMode: boolean;
  filterRegions?: string | string[];
  defaultRegion?: string;
  dedupMode: boolean;
}
