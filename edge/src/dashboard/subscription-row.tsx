"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Database,
  Download,
  Globe,
  MoreHorizontal,
  Pencil,
  QrCode,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import type { SubscriptionFormat } from "@subboost/core/subscription/output-format";
import { formatRelative, formatUsage, intervalLabel, ruleSchemeLabel } from "./format";
import type { EdgeSubscription } from "./types";

type Props = {
  subscription: EdgeSubscription;
  copied: boolean;
  refreshing: boolean;
  onCopy: (format: SubscriptionFormat) => void;
  onShowLink: () => void;
  onEdit: () => void;
  onSettings: () => void;
  onRefresh: () => void;
  onDownload: (format: SubscriptionFormat) => void;
  onDelete: () => void;
};

export function SubscriptionRow({
  subscription: sub,
  copied,
  refreshing,
  onCopy,
  onShowLink,
  onEdit,
  onSettings,
  onRefresh,
  onDownload,
  onDelete,
}: Props) {
  const lastError = sub.autoUpdateState.lastError;
  const failed = Boolean(lastError);
  const scheme = ruleSchemeLabel(sub);
  const updated = formatRelative(sub.lastUpdatedAt);
  const next = sub.autoUpdateInterval ? formatRelative(sub.nextUpdateAt) : null;
  const usage = formatUsage(sub.usage);
  const dotClass = failed ? "es-dot bad" : sub.autoUpdateInterval ? "es-dot" : "es-dot idle";

  return (
    <article className="es-row">
      <div className="es-row-main">
        <div className="es-row-t">
          <span className={dotClass} aria-label={failed ? "更新失败" : sub.autoUpdateInterval ? "自动更新正常" : "手动更新"} />
          <span className="es-row-name">{sub.name}</span>
          <span className={`es-badge ${scheme.remote ? "blue" : "brand"}`}>{scheme.label}</span>
          <span className="es-badge">{intervalLabel(sub.autoUpdateInterval)}</span>
          {failed && <span className="es-badge bad">更新失败</span>}
        </div>
        <div className="es-meta es-mono">
          {updated && (
            <span>
              <RefreshCw />
              {updated}
              {failed ? "成功更新" : "更新"}
            </span>
          )}
          {next && (
            <span>
              <Clock />
              {next}
              {failed ? "重试" : "更新"}
            </span>
          )}
          {typeof sub.nodeCount === "number" && (
            <span>
              <Globe />
              {sub.nodeCount} 个节点
            </span>
          )}
          {usage && (
            <span>
              <Database />
              {usage}
            </span>
          )}
        </div>
        {failed && (
          <div className="es-alert" role="status">
            <AlertTriangle />
            <div>
              <b>{formatRelative(sub.autoUpdateState.lastFailedAt) ?? ""}定时更新失败：</b>
              {lastError}。客户端仍会拿到{updated ? ` ${updated}` : "上次"}成功的配置。
            </div>
            <button type="button" className="es-alert-act" onClick={onRefresh} disabled={refreshing}>
              {refreshing ? "重试中…" : "立即重试"}
            </button>
          </div>
        )}
      </div>

      <div className="es-acts">
        <div className="es-split">
          <button type="button" className="es-btn pri" onClick={() => onCopy("clash")}>
            {copied ? <Check /> : <Copy />}
            {copied ? "已复制" : "复制链接"}
          </button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger className="es-btn pri" aria-label="选择订阅格式">
              <ChevronDown />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="es-menu" align="end" sideOffset={6}>
                <DropdownMenu.Item className="es-menu-item" onSelect={() => onCopy("clash")}>
                  <Copy />
                  复制 Clash / Mihomo 链接
                </DropdownMenu.Item>
                <DropdownMenu.Item className="es-menu-item" onSelect={() => onCopy("v2rayn")}>
                  <Copy />
                  复制 v2rayN 链接
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
        <button type="button" className="es-btn icon" onClick={onShowLink} title="二维码" aria-label="显示二维码">
          <QrCode />
        </button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger className="es-btn icon" title="更多操作" aria-label="更多操作">
            <MoreHorizontal />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="es-menu" align="end" sideOffset={6}>
              <DropdownMenu.Item className="es-menu-item" onSelect={onEdit}>
                <Pencil />
                编辑节点与规则
              </DropdownMenu.Item>
              <DropdownMenu.Item className="es-menu-item" onSelect={onSettings}>
                <SlidersHorizontal />
                名称与自动更新
              </DropdownMenu.Item>
              <DropdownMenu.Item className="es-menu-item" onSelect={onRefresh} disabled={refreshing}>
                <RefreshCw />
                {refreshing ? "刷新中…" : "立即刷新"}
              </DropdownMenu.Item>
              <div className="es-menu-sep" />
              <DropdownMenu.Item className="es-menu-item" onSelect={() => onDownload("clash")}>
                <Download />
                下载 Clash 配置
              </DropdownMenu.Item>
              <DropdownMenu.Item className="es-menu-item" onSelect={() => onDownload("v2rayn")}>
                <Download />
                下载 v2rayN 订阅
              </DropdownMenu.Item>
              <div className="es-menu-sep" />
              <DropdownMenu.Item className="es-menu-item danger" onSelect={onDelete}>
                <Trash2 />
                删除订阅…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </article>
  );
}
