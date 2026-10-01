import { create } from "zustand";
import type { ClashConversionProfileId } from "@subboost/core/subscription/clash-conversion-profiles";

type EditingSubscription = {
  id: string;
  token: string;
  name: string;
  autoUpdateInterval: number | null;
  smartNodeMatchingEnabled: boolean;
  conversionProfileId?: ClashConversionProfileId;
};

interface UIState {
  // 编辑“我的订阅”时的上下文（仅用于跨页面导航保留，不持久化到 localStorage）
  editingSubscription: EditingSubscription | null;
  setEditingSubscription: (subscription: EditingSubscription | null) => void;
  clearEditingSubscription: () => void;
}

export const useUIStore = create<UIState>()((set) => ({
  editingSubscription: null,
  setEditingSubscription: (subscription) => set({ editingSubscription: subscription }),
  clearEditingSubscription: () => set({ editingSubscription: null }),
}));


// 登录态失效跳转登录页时，编辑上下文需要和配置草稿一起带回，
// 否则重新登录后保存会新建一条订阅，而不是更新原订阅。
const EDITING_HANDOFF_STORAGE_NAME = "subboost-auth-editing-handoff";
const EDITING_HANDOFF_TTL_MS = 10 * 60 * 1000;

function getHandoffStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function captureEditingSubscriptionHandoff(): void {
  const storage = getHandoffStorage();
  if (!storage) return;
  const subscription = useUIStore.getState().editingSubscription;
  try {
    if (!subscription) storage.removeItem(EDITING_HANDOFF_STORAGE_NAME);
    else storage.setItem(EDITING_HANDOFF_STORAGE_NAME, JSON.stringify({ createdAt: Date.now(), subscription }));
  } catch {
    storage.removeItem(EDITING_HANDOFF_STORAGE_NAME);
  }
}

export function consumeEditingSubscriptionHandoff(): EditingSubscription | null {
  const storage = getHandoffStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(EDITING_HANDOFF_STORAGE_NAME);
    storage.removeItem(EDITING_HANDOFF_STORAGE_NAME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { createdAt?: unknown; subscription?: Partial<EditingSubscription> };
    const subscription = parsed.subscription;
    if (typeof parsed.createdAt !== "number" || Date.now() - parsed.createdAt > EDITING_HANDOFF_TTL_MS) return null;
    if (
      !subscription ||
      typeof subscription.id !== "string" ||
      typeof subscription.token !== "string" ||
      typeof subscription.name !== "string" ||
      (subscription.autoUpdateInterval !== null && typeof subscription.autoUpdateInterval !== "number") ||
      typeof subscription.smartNodeMatchingEnabled !== "boolean"
    ) {
      return null;
    }
    return subscription as EditingSubscription;
  } catch {
    storage.removeItem(EDITING_HANDOFF_STORAGE_NAME);
    return null;
  }
}
