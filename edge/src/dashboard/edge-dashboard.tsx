"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, Check, Clock, Layers, LogIn, Plus, Search } from "lucide-react";
import { confirmDialog } from "@subboost/ui/components/ui/confirm-dialog";
import { toast, ToastAction } from "@subboost/ui/components/ui/toaster";
import { useUserStore } from "@subboost/ui/store/user-store";
import { isUnauthorizedError } from "@subboost/ui/dashboard/dashboard-errors";
import { buildRefreshSubscriptionSuccessToast } from "@subboost/ui/dashboard/dashboard-refresh-toast";
import { SubscriptionSettingsDialog } from "@subboost/ui/dashboard/subscription-settings-dialog";
import {
  autoUpdateIntervalHoursToSeconds,
  autoUpdateIntervalSecondsToHours,
  resolveAutoUpdateIntervalPolicy,
} from "@subboost/core/subscription/auto-update-interval";
import { buildSubscriptionFormatUrl, type SubscriptionFormat } from "@subboost/core/subscription/output-format";
import * as api from "./api";
import { copyText, downloadSubscription } from "./browser";
import { formatDayTime, nextCronRun, ruleSchemeLabel } from "./format";
import { LinkDialog } from "./link-dialog";
import { RuleLibraryLine } from "./rule-library-line";
import { SubscriptionRow } from "./subscription-row";
import type { EdgeSubscription, SubscriptionFilter } from "./types";

const LOGIN_HREF = "/login?next=/dashboard";
const AUTO_UPDATE_POLICY = resolveAutoUpdateIntervalPolicy(true, {
  defaultHours: 24,
  minHours: 6,
  stepHours: 6,
  requireIntegerHours: true,
  scheduleNote: "每 6 小时批量执行一次，按间隔对齐到最近一次执行",
});

const FILTERS: Array<{ id: SubscriptionFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "failed", label: "更新失败" },
  { id: "auto", label: "自动更新" },
  { id: "manual", label: "手动" },
];

function matchesFilter(sub: EdgeSubscription, filter: SubscriptionFilter): boolean {
  if (filter === "failed") return Boolean(sub.autoUpdateState.lastError);
  if (filter === "auto") return Boolean(sub.autoUpdateInterval);
  if (filter === "manual") return !sub.autoUpdateInterval;
  return true;
}

function LoginPrompt() {
  return (
    <div className="es-page">
      <div className="es-card es-empty">
        <LogIn />
        <h2>请先登录</h2>
        <p>登录后即可管理已保存的订阅。</p>
        <Link href={LOGIN_HREF} className="es-btn pri">
          去登录
        </Link>
      </div>
    </div>
  );
}

export function EdgeDashboard() {
  const { user, isLoading: userLoading, fetchUser, clearUser } = useUserStore();
  const [subscriptions, setSubscriptions] = React.useState<EdgeSubscription[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<SubscriptionFilter>("all");
  const [query, setQuery] = React.useState("");
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const [refreshingId, setRefreshingId] = React.useState<string | null>(null);
  const [linkTarget, setLinkTarget] = React.useState<EdgeSubscription | null>(null);
  const [settingsTarget, setSettingsTarget] = React.useState<EdgeSubscription | null>(null);
  const [settingsName, setSettingsName] = React.useState("");
  const [smartNodeMatching, setSmartNodeMatching] = React.useState(true);
  const [autoUpdateEnabled, setAutoUpdateEnabled] = React.useState(false);
  const [autoUpdateHours, setAutoUpdateHours] = React.useState(AUTO_UPDATE_POLICY.defaultHours);
  const [savingSettings, setSavingSettings] = React.useState(false);

  React.useEffect(() => {
    void fetchUser();
  }, [fetchUser]);

  const load = React.useCallback(async () => {
    try {
      setSubscriptions(await api.fetchSubscriptions());
      setLoadError(null);
    } catch (error) {
      if (isUnauthorizedError(error)) {
        clearUser();
        return;
      }
      // Keep what is already on screen; an empty list would read as "no subscriptions".
      setLoadError(error instanceof Error ? error.message : "加载订阅失败");
    } finally {
      setLoading(false);
    }
  }, [clearUser]);

  React.useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    void load();
  }, [user, load]);

  const showActionError = (error: unknown, fallback: string) => {
    if (isUnauthorizedError(error)) {
      toast({
        title: "登录已过期",
        description: "请重新登录后再操作。",
        variant: "warning",
        action: (
          <ToastAction altText="去登录" onClick={() => (window.location.href = LOGIN_HREF)}>
            去登录
          </ToastAction>
        ),
      });
      return;
    }
    toast({ title: fallback, description: error instanceof Error ? error.message : undefined, variant: "destructive" });
  };

  const copy = async (sub: EdgeSubscription, format: SubscriptionFormat) => {
    const ok = await copyText(buildSubscriptionFormatUrl(sub.subscriptionUrl, format));
    if (!ok) {
      toast({ title: "复制失败", description: "请点二维码按钮，在弹窗中手动复制链接。", variant: "destructive" });
      return;
    }
    const key = `${sub.id}:${format}`;
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 2000);
    if (format === "v2rayn") toast({ title: "已复制 v2rayN 链接", variant: "success" });
  };

  const download = async (sub: EdgeSubscription, format: SubscriptionFormat) => {
    try {
      await downloadSubscription(sub.name, sub.subscriptionUrl, format);
    } catch (error) {
      showActionError(error, "下载失败");
    }
  };

  const refresh = async (sub: EdgeSubscription) => {
    if (refreshingId) {
      toast({ title: "正在刷新另一个订阅，请稍候", variant: "warning" });
      return;
    }
    setRefreshingId(sub.id);
    try {
      const data = await api.refreshSubscription(sub.id);
      await load();
      toast(buildRefreshSubscriptionSuccessToast(data));
    } catch (error) {
      showActionError(error, "刷新失败");
    } finally {
      setRefreshingId(null);
    }
  };

  const remove = async (sub: EdgeSubscription) => {
    const ok = await confirmDialog({
      title: `删除「${sub.name}」？`,
      description: "删除后，客户端里使用这个订阅链接的配置将无法再更新，且无法恢复。",
      confirmText: "删除",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await api.deleteSubscription(sub.id);
      setSubscriptions((prev) => prev.filter((item) => item.id !== sub.id));
      toast({ title: `已删除「${sub.name}」`, variant: "success" });
    } catch (error) {
      showActionError(error, "删除失败");
    }
  };

  const openSettings = (sub: EdgeSubscription) => {
    setSettingsTarget(sub);
    setSettingsName(sub.name);
    setSmartNodeMatching(sub.smartNodeMatchingEnabled !== false);
    setAutoUpdateEnabled(Boolean(sub.autoUpdateInterval));
    const hours = sub.autoUpdateInterval ? autoUpdateIntervalSecondsToHours(sub.autoUpdateInterval) : AUTO_UPDATE_POLICY.defaultHours;
    setAutoUpdateHours(Math.max(AUTO_UPDATE_POLICY.minHours, hours));
  };

  const saveSettings = async () => {
    if (!settingsTarget || savingSettings) return;
    const name = settingsName.trim();
    if (!name || name.length > 100) {
      toast({ title: "订阅名称不能为空且不能超过 100 个字符", variant: "warning" });
      return;
    }
    const hours = Number(autoUpdateHours);
    if (autoUpdateEnabled && (!Number.isInteger(hours) || hours < AUTO_UPDATE_POLICY.minHours)) {
      toast({ title: `自动更新间隔需为不小于 ${AUTO_UPDATE_POLICY.minHours} 的整数小时`, variant: "warning" });
      return;
    }
    setSavingSettings(true);
    try {
      await api.updateSubscriptionSettings(settingsTarget.id, {
        name,
        smartNodeMatchingEnabled: smartNodeMatching,
        autoUpdateInterval: autoUpdateEnabled ? autoUpdateIntervalHoursToSeconds(hours) : null,
      });
      setSettingsTarget(null);
      await load();
    } catch (error) {
      showActionError(error, "保存失败");
    } finally {
      setSavingSettings(false);
    }
  };

  if (userLoading && !user) return <div className="es-page" aria-busy="true" />;
  if (!user) return <LoginPrompt />;

  const failedCount = subscriptions.filter((sub) => sub.autoUpdateState.lastError).length;
  const autoCount = subscriptions.filter((sub) => sub.autoUpdateInterval).length;
  const healthyAuto = subscriptions.filter((sub) => sub.autoUpdateInterval && !sub.autoUpdateState.lastError).length;
  const counts: Record<SubscriptionFilter, number> = {
    all: subscriptions.length,
    failed: failedCount,
    auto: autoCount,
    manual: subscriptions.length - autoCount,
  };
  const keyword = query.trim().toLowerCase();
  const visible = subscriptions.filter(
    (sub) => matchesFilter(sub, filter) && (!keyword || sub.name.toLowerCase().includes(keyword))
  );

  return (
    <div className="es-page">
      <div className="es-ph">
        <div>
          <h1>我的订阅</h1>
          <p className="es-only-d">
            {subscriptions.length} 个订阅 · 自动更新每 6 小时批量执行一次
          </p>
        </div>
        <Link href="/?newSubscription=1" className="es-btn pri">
          <Plus />
          新建订阅
        </Link>
      </div>

      <section className="es-tiles">
        <div className="es-card es-tile">
          <div className="es-tile-ic">
            <Layers />
          </div>
          <div>
            <div className="es-tile-v es-mono">{subscriptions.length}</div>
            <div className="es-tile-l">订阅</div>
          </div>
        </div>
        <div className="es-card es-tile">
          <div className="es-tile-ic">
            <Check />
          </div>
          <div>
            <div className="es-tile-v es-mono">{healthyAuto}</div>
            <div className="es-tile-l">自动更新正常</div>
          </div>
        </div>
        <button
          type="button"
          className={`es-card es-tile${failedCount ? " bad" : ""}`}
          onClick={() => setFilter(failedCount ? "failed" : "all")}
          aria-label={`更新失败 ${failedCount} 个，点击筛选`}
        >
          <div className="es-tile-ic">
            <AlertTriangle />
          </div>
          <div>
            <div className="es-tile-v es-mono">{failedCount}</div>
            <div className="es-tile-l">更新失败</div>
          </div>
        </button>
        <div className="es-card es-tile">
          <div className="es-tile-ic">
            <Clock />
          </div>
          <div>
            <div className="es-tile-v es-mono es-tile-v-sm">{formatDayTime(nextCronRun())}</div>
            <div className="es-tile-l">下次定时更新</div>
          </div>
        </div>
      </section>

      <section className="es-card">
        <div className="es-lh">
          <div className="es-tabs" role="tablist" aria-label="筛选订阅">
            {FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={filter === item.id}
                className={`${filter === item.id ? "on" : ""}${item.id === "failed" && failedCount ? " bad" : ""}`}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
                <span className="es-tab-n es-mono">{counts[item.id]}</span>
              </button>
            ))}
          </div>
          <label className="es-search">
            <Search />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索订阅" aria-label="搜索订阅" />
          </label>
        </div>

        {loading ? (
          <div className="es-skel" aria-busy="true">
            <div />
            <div />
          </div>
        ) : loadError && subscriptions.length === 0 ? (
          <div className="es-empty">
            <AlertTriangle />
            <h2>订阅列表加载失败</h2>
            <p>{loadError}</p>
            <button
              type="button"
              className="es-btn pri"
              onClick={() => {
                setLoading(true);
                void load();
              }}
            >
              重试
            </button>
          </div>
        ) : subscriptions.length === 0 ? (
          <div className="es-empty">
            <Layers />
            <h2>还没有订阅</h2>
            <p>导入节点、选择规则，保存后即可得到订阅链接。</p>
            <Link href="/?newSubscription=1" className="es-btn pri">
              <Plus />
              新建订阅
            </Link>
          </div>
        ) : visible.length === 0 ? (
          <div className="es-empty compact">
            <p>没有符合条件的订阅。</p>
          </div>
        ) : (
          visible.map((sub) => (
            <SubscriptionRow
              key={sub.id}
              subscription={sub}
              copied={copiedKey === `${sub.id}:clash`}
              refreshing={refreshingId === sub.id}
              onCopy={(format) => void copy(sub, format)}
              onShowLink={() => setLinkTarget(sub)}
              onEdit={() => (window.location.href = `/?editSubscriptionId=${encodeURIComponent(sub.id)}`)}
              onSettings={() => openSettings(sub)}
              onRefresh={() => void refresh(sub)}
              onDownload={(format) => void download(sub, format)}
              onDelete={() => void remove(sub)}
            />
          ))
        )}
      </section>

      <RuleLibraryLine />

      {linkTarget && (
        <LinkDialog
          open
          onOpenChange={(open) => !open && setLinkTarget(null)}
          name={linkTarget.name}
          subtitle={ruleSchemeLabel(linkTarget).label}
          subscriptionUrl={linkTarget.subscriptionUrl}
        />
      )}
      <SubscriptionSettingsDialog
        open={Boolean(settingsTarget)}
        onOpenChange={(open) => !open && setSettingsTarget(null)}
        subscription={settingsTarget}
        settingsName={settingsName}
        setSettingsName={setSettingsName}
        smartNodeMatchingEnabled={smartNodeMatching}
        setSmartNodeMatchingEnabled={setSmartNodeMatching}
        autoUpdateEnabled={autoUpdateEnabled}
        setAutoUpdateEnabled={setAutoUpdateEnabled}
        autoUpdateHours={autoUpdateHours}
        setAutoUpdateHours={setAutoUpdateHours}
        savingSettings={savingSettings}
        onSave={() => void saveSettings()}
        userIsAdmin
        autoUpdatePolicy={AUTO_UPDATE_POLICY}
      />
    </div>
  );
}
