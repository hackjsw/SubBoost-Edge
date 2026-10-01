"use client";

import {
  SubscriptionDashboardSurface,
  type DashboardSurfaceAdapter,
} from "@subboost/ui/dashboard/subscription-dashboard-surface";
import type {
  RefreshSubscriptionResponse,
  Subscription,
} from "@subboost/ui/dashboard/dashboard-types";
import { DashboardApiError } from "@subboost/ui/dashboard/dashboard-errors";
import { RuleLibraryStatus } from "@edge/components/rule-library-status";

async function readApiResponse<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new DashboardApiError(data.error || `请求失败 (HTTP ${response.status})`, response.status);
  return data;
}

const edgeDashboardAdapter: DashboardSurfaceAdapter = {
  supportsV2rayN: true,
  loginHref: "/login?next=/dashboard",
  templatesHref: null,
  settingsHref: null,
  beforeStatsSlot: <RuleLibraryStatus />,
  autoUpdateIntervalPolicy: {
    defaultHours: 24,
    minHours: 6,
    stepHours: 6,
    scheduleNote: "每 6 小时批量执行一次，按间隔对齐到最近一次执行",
    requireIntegerHours: true,
  },
  editSubscriptionHref: (subscription) => `/?editSubscriptionId=${encodeURIComponent(subscription.id)}`,
  fetchSubscriptions: async () => {
    const data = await readApiResponse<{ subscriptions?: Subscription[] }>(
      await fetch("/api/subscriptions", { cache: "no-store" })
    );
    return Array.isArray(data.subscriptions) ? data.subscriptions : [];
  },
  deleteSubscription: async (id) => {
    await readApiResponse<unknown>(
      await fetch(`/api/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE" })
    );
  },
  refreshSubscription: async (id): Promise<RefreshSubscriptionResponse> => {
    return readApiResponse<RefreshSubscriptionResponse>(
      await fetch(`/api/subscriptions/${encodeURIComponent(id)}/refresh`, { method: "POST" })
    );
  },
  updateSubscriptionSettings: async (id, payload) => {
    await readApiResponse<unknown>(
      await fetch(`/api/subscriptions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    );
  },
};

export default function DashboardPage() {
  return <SubscriptionDashboardSurface adapter={edgeDashboardAdapter} />;
}
