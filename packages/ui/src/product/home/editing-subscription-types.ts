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
  // 草稿作用域切换会重置编辑器，需等登录态确认后再加载，否则加载结果会被清空
  enabled?: boolean;
  userId?: string | null;
  authChecked?: boolean;
  loadSubscription?: (id: string) => Promise<Response>;
  loginHref?: string;
  setCopied: (copied: boolean) => void;
  setEditingSubscription: (subscription: EditingSubscription | null) => void;
  setStoreSources: (sources: SubscriptionSource[]) => void;
  setSubscriptionName: (name: string) => void;
  setSubscriptionUrl: (url: string) => void;
};
