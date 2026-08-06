import type { SubscriptionSource } from "@subboost/ui/store/config-store";
import type { ClashConversionProfileId } from "@subboost/core/subscription/clash-conversion-profiles";

export type EditingSubscription = {
  id: string;
  token: string;
  name: string;
  autoUpdateInterval: number | null;
  smartNodeMatchingEnabled: boolean;
  conversionProfileId?: ClashConversionProfileId;
};

export type EditingSubscriptionLoaderOptions = {
  editSubscriptionId: string | null;
  loadSubscription?: (id: string) => Promise<Response>;
  loginHref?: string;
  setCopied: (copied: boolean) => void;
  setEditingSubscription: (subscription: EditingSubscription | null) => void;
  setStoreSources: (sources: SubscriptionSource[]) => void;
  setSubscriptionName: (name: string) => void;
  setSubscriptionUrl: (url: string) => void;
};
