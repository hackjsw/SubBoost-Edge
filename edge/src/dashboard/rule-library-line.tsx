"use client";

import * as React from "react";
import { Database, RefreshCw } from "lucide-react";
import { toast } from "@subboost/ui/components/ui/toaster";
import { fetchRuleCatalogStatus, refreshRuleCatalogStatus } from "@edge/components/rule-library-status";
import type { RuleCatalogStatusResponse } from "@edge/lib/rule-catalog-status";
import { formatDayTime, formatRelative } from "./format";

const SOURCE_LABELS: Record<RuleCatalogStatusResponse["source"], string> = {
  remote: "",
  stale: " · 上游同步失败，使用缓存",
  bundled: " · 使用内置目录",
};

export function RuleLibraryLine() {
  const [status, setStatus] = React.useState<RuleCatalogStatusResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  React.useEffect(() => {
    const controller = new AbortController();
    fetchRuleCatalogStatus(fetch, controller.signal)
      .then(setStatus)
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : "规则库状态暂不可用");
      });
    return () => controller.abort();
  }, []);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const next = await refreshRuleCatalogStatus();
      setStatus(next);
      setError(null);
      toast(
        next.refreshStatus === "stale"
          ? { title: "上游同步失败，继续使用缓存", description: next.error || "现有规则仍可使用", variant: "warning" }
          : { title: "规则库已同步", description: `当前共 ${next.totalRules.toLocaleString("zh-CN")} 条规则`, variant: "success" }
      );
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
    <section className="es-card es-foot-status">
      <Database />
      <b>规则库</b>
      <span>
        {status
          ? `${status.sourceLabel} · ${status.totalRules.toLocaleString("zh-CN")} 条规则 · ${
              status.fetchedAt === null ? "尚未" : formatRelative(new Date(status.fetchedAt).toISOString()) ?? ""
            }同步 · 下次 ${formatDayTime(new Date(status.nextScheduledAt))}${SOURCE_LABELS[status.source]}`
          : error ?? "正在读取…"}
      </span>
      <span className="es-sp" />
      <button type="button" className="es-btn sm" onClick={() => void refresh()} disabled={refreshing}>
        <RefreshCw />
        {refreshing ? "同步中…" : "立即同步"}
      </button>
    </section>
  );
}
