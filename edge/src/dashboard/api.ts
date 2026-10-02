import { DashboardApiError } from "@subboost/ui/dashboard/dashboard-errors";
import type { RefreshSubscriptionResponse } from "@subboost/ui/dashboard/dashboard-types";
import type { EdgeSubscription } from "./types";

async function readApiResponse<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new DashboardApiError(data.error || `请求失败 (HTTP ${response.status})`, response.status);
  return data;
}

const subscriptionPath = (id: string) => `/api/subscriptions/${encodeURIComponent(id)}`;

export async function fetchSubscriptions(): Promise<EdgeSubscription[]> {
  const data = await readApiResponse<{ subscriptions?: EdgeSubscription[] }>(
    await fetch("/api/subscriptions", { cache: "no-store" })
  );
  return Array.isArray(data.subscriptions) ? data.subscriptions : [];
}

export async function deleteSubscription(id: string): Promise<void> {
  await readApiResponse<unknown>(await fetch(subscriptionPath(id), { method: "DELETE" }));
}

export async function refreshSubscription(id: string): Promise<RefreshSubscriptionResponse> {
  return readApiResponse<RefreshSubscriptionResponse>(await fetch(`${subscriptionPath(id)}/refresh`, { method: "POST" }));
}

export type SubscriptionSettingsPayload = {
  name: string;
  smartNodeMatchingEnabled: boolean;
  autoUpdateInterval: number | null;
};

export async function updateSubscriptionSettings(id: string, payload: SubscriptionSettingsPayload): Promise<void> {
  await readApiResponse<unknown>(
    await fetch(subscriptionPath(id), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );
}
