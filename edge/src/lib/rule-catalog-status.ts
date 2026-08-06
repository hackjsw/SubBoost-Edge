export type RuleCatalogStatusSource = "remote" | "stale" | "bundled";

export type RuleCatalogStatusResponse = {
  source: RuleCatalogStatusSource;
  sourceLabel: string;
  sourceUrl: string;
  geositeCount: number;
  geoipCount: number;
  totalRules: number;
  fetchedAt: number | null;
  expiresAt: number | null;
  schedule: string;
  nextScheduledAt: number;
};

export type RuleCatalogRefreshResponse = RuleCatalogStatusResponse & {
  refreshStatus: "skipped" | "refreshed" | "stale";
  error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isTimestamp(value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function isRuleCatalogStatusResponse(value: unknown): value is RuleCatalogStatusResponse {
  if (!isRecord(value)) return false;
  return (
    (value.source === "remote" || value.source === "stale" || value.source === "bundled") &&
    typeof value.sourceLabel === "string" && value.sourceLabel.trim().length > 0 &&
    isHttpUrl(value.sourceUrl) &&
    isNonNegativeInteger(value.geositeCount) &&
    isNonNegativeInteger(value.geoipCount) &&
    isNonNegativeInteger(value.totalRules) &&
    value.totalRules === value.geositeCount + value.geoipCount &&
    isNullableTimestamp(value.fetchedAt) &&
    isNullableTimestamp(value.expiresAt) &&
    typeof value.schedule === "string" && value.schedule.trim().length > 0 &&
    isTimestamp(value.nextScheduledAt)
  );
}

export function isRuleCatalogRefreshResponse(value: unknown): value is RuleCatalogRefreshResponse {
  if (!isRecord(value)) return false;
  const refreshStatus = value.refreshStatus;
  const error = value.error;
  if (!isRuleCatalogStatusResponse(value)) return false;
  return (
    (refreshStatus === "skipped" || refreshStatus === "refreshed" || refreshStatus === "stale") &&
    (error === undefined || typeof error === "string")
  );
}
