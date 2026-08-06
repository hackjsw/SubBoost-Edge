"use client";

import { HomeSurface, type HomeSurfaceAdapter } from "@subboost/ui/product/home/home-surface";
import { createRulesProductApi } from "@subboost/ui/product/api-adapter";
import { readSourceImportResponse } from "@subboost/ui/product/client-response";
import { useConfigStore } from "@subboost/ui/store/config-store";
import {
  CLASH_CONVERSION_PROFILES,
  DEFAULT_CLASH_CONVERSION_PROFILE_ID,
} from "@subboost/core/subscription/clash-conversion-profiles";

const edgeHomeAdapter: HomeSurfaceAdapter = {
  brandName: "EdgeSub",
  brandDescription: "在 Cloudflare Edge 上转换、保存并按计划更新 Clash 与 Mihomo 订阅",
  loginHref: "/login",
  loadSubscription: (id) => fetch(`/api/subscriptions/${encodeURIComponent(id)}`, { cache: "no-store" }),
  templateUploadHref: null,
  productApi: {
    sourceImport: {
      importSource: async (request) => {
        const data = await readSourceImportResponse(
          await fetch("/api/source-import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
          })
        );
        return {
          content: typeof data.content === "string" ? data.content : "",
          headers: data.headers || {},
          parseResult: data.parseResult,
        };
      },
    },
    templates: {
      catalogEnabled: false,
      builtinEngagementEnabled: false,
    },
    rules: createRulesProductApi(),
  },
  subscription: {
    loginHref: "/login",
    autoUpdateIntervalPolicy: {
      defaultHours: 24,
      minHours: 1,
      stepHours: 1,
      requireIntegerHours: true,
    },
    defaultAutoUpdateEnabled: true,
    linkStorageMode: "persistent-kv",
    conversionProfiles: CLASH_CONVERSION_PROFILES,
    defaultConversionProfileId: DEFAULT_CLASH_CONVERSION_PROFILE_ID,
    saveSubscription: async ({ payload, isEditing, subscriptionId }) => {
      const generatedYaml = useConfigStore.getState().generatedYaml;
      const target = isEditing && subscriptionId
        ? `/api/subscriptions/${encodeURIComponent(subscriptionId)}`
        : "/api/subscriptions";
      return fetch(target, {
        method: isEditing && subscriptionId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          yaml: generatedYaml,
        }),
      });
    },
  },
};

export default function Page() {
  return <HomeSurface adapter={edgeHomeAdapter} />;
}
