import type { Subscription } from "@subboost/ui/dashboard/dashboard-types";
import type { ClashConversionProfileId } from "@subboost/core/subscription/clash-conversion-profiles";

export type SubscriptionUsage = {
  usedBytes: number | null;
  totalBytes: number | null;
  expireAt: string | null;
};

// Shape returned by GET /api/subscriptions on the edge worker.
export type EdgeSubscription = Subscription & {
  conversionProfileId?: ClashConversionProfileId;
  template?: string | null;
  nextUpdateAt?: string | null;
  nodeCount?: number;
  usage?: SubscriptionUsage | null;
};

export type SubscriptionFilter = "all" | "failed" | "auto" | "manual";
