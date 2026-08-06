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


