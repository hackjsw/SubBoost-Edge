"use client";

import * as React from "react";
import { AlertTriangle, Database, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@subboost/ui/components/ui/button";
import { toast } from "@subboost/ui/components/ui/toaster";
import {
  isRuleCatalogRefreshResponse,
  isRuleCatalogStatusResponse,
  type RuleCatalogRefreshResponse,
  type RuleCatalogStatusResponse,
  type RuleCatalogStatusSource,
} from "@edge/lib/rule-catalog-status";

type FetchLike = typeof fetch;

function apiErrorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const error = (value as Record<string, unknown>).error;
  return typeof error === "string" && error.trim() ? error : fallback;
}

async function readStatusResponse<T>(
  response: Response,
  isValid: (value: unknown) => value is T
): Promise<T> {
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(apiErrorMessage(data, `请求失败 (HTTP ${response.status})`));
  }
  if (!isValid(data)) throw new Error("规则库状态响应无效");
  return data;
}

export async function fetchRuleCatalogStatus(
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal
): Promise<RuleCatalogStatusResponse> {
  return readStatusResponse(
    await fetchImpl("/api/rules/status", { cache: "no-store", signal }),
    isRuleCatalogStatusResponse
  );
}

export async function refreshRuleCatalogStatus(
  fetchImpl: FetchLike = fetch
): Promise<RuleCatalogRefreshResponse> {
  return readStatusResponse(
    await fetchImpl("/api/rules/refresh", { method: "POST" }),
    isRuleCatalogRefreshResponse
  );
}

const sourcePresentation: Record<
  RuleCatalogStatusSource,
  { label: string; className: string }
> = {
  remote: {
    label: "远端索引",
    className: "border-[#9dcfc6] bg-[#edf9f7] text-[#05665b]",
  },
  stale: {
    label: "过期缓存",
    className: "border-[#e4c48f] bg-[#fff8e8] text-[#8a4b08]",
  },
  bundled: {
    label: "内置规则",
    className: "border-[#a9bce9] bg-[#f1f5ff] text-[#315fcb]",
  },
};

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatTimestamp(value: number | null, fallback: string): string {
  if (value === null) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : dateTimeFormatter.format(date);
}

type RuleLibraryStatusViewProps = {
  status: RuleCatalogStatusResponse | null;
  loading: boolean;
  error: string | null;
  refreshing: boolean;
  onRetry: () => void;
  onRefresh: () => void;
};

export function RuleLibraryStatusView({
  status,
  loading,
  error,
  refreshing,
  onRetry,
  onRefresh,
}: RuleLibraryStatusViewProps) {
  if (loading) {
    return (
      <section
        className="mb-5 min-h-[176px] rounded-lg border border-[#d7e0de] bg-white p-4 shadow-[0_8px_24px_rgba(23,35,33,0.06)]"
        aria-busy="true"
        aria-label="正在加载规则库状态"
      >
        <div className="flex items-center justify-between gap-4">
          <div className="h-5 w-36 animate-pulse rounded bg-[#dfe8e6]" />
          <div className="h-8 w-24 animate-pulse rounded bg-[#dfe8e6]" />
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="h-12 animate-pulse rounded bg-[#edf3f1]" />
          ))}
        </div>
        <div className="mt-4 h-4 w-3/5 animate-pulse rounded bg-[#dfe8e6]" />
      </section>
    );
  }

  if (!status) {
    return (
      <section
        className="mb-5 flex min-h-[176px] flex-col justify-between gap-5 rounded-lg border border-[#ecc5bd] bg-white p-4 shadow-[0_8px_24px_rgba(23,35,33,0.06)] sm:flex-row sm:items-center"
        role="alert"
      >
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-lg bg-[#fff3f0] p-2 text-[#b54236]">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold text-[#172321]">规则库状态暂不可用</h2>
            <p className="mt-1 break-words text-sm text-[#60706d]">{error || "请稍后重试"}</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="shrink-0 border-[#d7e0de] bg-[#f8faf9] text-[#475754] hover:border-[#9dc9c2] hover:bg-[#edf9f7] hover:text-[#05665b]"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          重试
        </Button>
      </section>
    );
  }

  const source = sourcePresentation[status.source];
  return (
    <section
      className="mb-5 min-h-[176px] overflow-hidden rounded-lg border border-[#d7e0de] bg-white shadow-[0_8px_24px_rgba(23,35,33,0.06)]"
      aria-live="polite"
    >
      {error ? (
        <div
          className="flex flex-col gap-3 border-b border-[#ecc5bd] bg-[#fff3f0] px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          role="alert"
        >
          <div className="flex min-w-0 items-start gap-2 text-sm text-[#8d352c]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="break-words">状态更新失败：{error}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="shrink-0 border-[#e4aaa0] bg-white text-[#8d352c] hover:bg-[#fff8f6] hover:text-[#7b2d25]"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            重试状态
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded-lg bg-[#edf9f7] p-2 text-[#087f70]">
            <Database className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold text-[#172321]">规则库</h2>
              <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${source.className}`}>
                {source.label}
              </span>
            </div>
            <a
              href={status.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex max-w-full items-center gap-1 truncate text-sm text-[#60706d] hover:text-[#05665b]"
            >
              <span className="truncate">{status.sourceLabel}</span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            </a>
          </div>
        </div>
        <Button
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
          className="shrink-0 border-[#087f70] bg-[#087f70] text-[#ffffff] hover:border-[#05665b] hover:bg-[#05665b]"
        >
          <RefreshCw
            className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          {refreshing ? "同步中" : "立即同步"}
        </Button>
      </div>

      <dl className="grid grid-cols-2 border-t border-[#d7e0de] md:grid-cols-4">
        <StatusFact label="当前来源" value={source.label} />
        <StatusFact label="GeoSite" value={status.geositeCount.toLocaleString("zh-CN")} />
        <StatusFact label="GeoIP" value={status.geoipCount.toLocaleString("zh-CN")} />
        <StatusFact label="规则总数" value={status.totalRules.toLocaleString("zh-CN")} />
      </dl>

      <div className="flex flex-col gap-1 border-t border-[#d7e0de] px-4 py-3 text-xs text-[#60706d] sm:flex-row sm:items-center sm:gap-5">
        <span>上次同步：{formatTimestamp(status.fetchedAt, "尚未进行远端同步")}</span>
        <span>下次同步：{formatTimestamp(status.nextScheduledAt, "等待 Cron 调度")}</span>
      </div>
    </section>
  );
}

function StatusFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-[#d7e0de] px-4 py-3 [&:nth-child(even)]:border-l md:[&:not(:first-child)]:border-l">
      <dt className="text-xs text-[#60706d]">{label}</dt>
      <dd className="mt-1 truncate text-sm font-semibold text-[#172321]" title={value}>
        {value}
      </dd>
    </div>
  );
}

export function RuleLibraryStatus() {
  const [status, setStatus] = React.useState<RuleCatalogStatusResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  const loadStatus = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchRuleCatalogStatus(fetch, signal);
      if (!signal?.aborted) setStatus(next);
    } catch (loadError) {
      if (!signal?.aborted) {
        setError(loadError instanceof Error ? loadError.message : "规则库状态暂不可用");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    void loadStatus(controller.signal);
    return () => controller.abort();
  }, [loadStatus]);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const next = await refreshRuleCatalogStatus();
      setStatus(next);
      setError(null);
      if (next.refreshStatus === "stale") {
        toast({
          title: "上游同步失败，继续使用缓存",
          description: next.error || "现有规则仍可使用",
          variant: "warning",
        });
      } else {
        toast({
          title: "规则库已同步",
          description: `当前共 ${next.totalRules.toLocaleString("zh-CN")} 条规则`,
          variant: "success",
        });
      }
    } catch (refreshError) {
      toast({
        title: "规则库同步失败",
        description: refreshError instanceof Error ? refreshError.message : "请稍后重试",
        variant: "destructive",
      });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <RuleLibraryStatusView
      status={status}
      loading={loading}
      error={error}
      refreshing={refreshing}
      onRetry={() => void loadStatus()}
      onRefresh={() => void refresh()}
    />
  );
}
