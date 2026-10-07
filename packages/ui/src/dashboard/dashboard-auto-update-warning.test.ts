import { describe, expect, it } from "vitest";
import {
  buildAutoUpdateDisabledNotice,
  buildNodeQuotaWarning,
  buildQuotaDisabledRecoveryText,
  createResetDashboardAutoUpdateState,
  isNodeQuotaAutoUpdateDisabled,
} from "./dashboard-auto-update-warning";

const baseSubscription = {
  id: "sub-1",
  token: "token-1",
  name: "Primary",
  subscriptionUrl: "https://example.com/sub",
  isPrimary: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastAccessedAt: null,
  lastUpdatedAt: null,
  autoUpdateInterval: null,
  smartNodeMatchingEnabled: true,
  autoUpdateState: createResetDashboardAutoUpdateState(),
};

function disabledSubscription(reason: string, name = "Primary") {
  return {
    ...baseSubscription,
    name,
    autoUpdateState: {
      ...baseSubscription.autoUpdateState,
      disabledAt: "2026-01-02T00:00:00.000Z",
      disabledReason: reason,
    },
  };
}

describe("dashboard auto-update warning helpers", () => {
  it("builds reset state and omits a warning before quota failures", () => {
    const state = createResetDashboardAutoUpdateState();
    expect(state).toMatchObject({
      externalFailureCount: 0,
      nodeQuotaFailureCount: 0,
      disabledAt: null,
    });
    expect(buildNodeQuotaWarning(state)).toBeNull();
    expect(isNodeQuotaAutoUpdateDisabled(state)).toBe(false);
  });

  it("formats unknown quota facts and uses the fallback recovery reason", () => {
    const state = {
      ...createResetDashboardAutoUpdateState(),
      nodeQuotaFailureCount: 1,
    };
    expect(buildNodeQuotaWarning(state)).toBe("节点数超出配额：实际 未知，额度 未知（连续 1/3 次）");
    expect(buildQuotaDisabledRecoveryText(createResetDashboardAutoUpdateState())).toContain("节点数连续超过配额");
  });

  it("builds empty and single-subscription notices", () => {
    expect(buildAutoUpdateDisabledNotice([])).toEqual({ title: "自动更新已关闭", description: "" });

    const source = disabledSubscription("fetch_failed");
    expect(buildAutoUpdateDisabledNotice([source])).toEqual({
      title: "自动更新已关闭",
      description: expect.stringContaining("订阅源连续拉取失败"),
    });

    const quota = disabledSubscription("节点数连续超过配额", "Quota");
    expect(isNodeQuotaAutoUpdateDisabled(quota.autoUpdateState)).toBe(true);
    expect(buildAutoUpdateDisabledNotice([quota]).description).toContain("请减少导入节点或订阅源");
  });

  it("keeps quota-only and source-only multi-subscription guidance separate", () => {
    const quotaA = disabledSubscription("节点数连续超过配额", "Quota A");
    const quotaB = { ...quotaA, id: "sub-2", name: "Quota B" };
    const quotaNotice = buildAutoUpdateDisabledNotice([quotaA, quotaB]);
    expect(quotaNotice.title).toBe("2 个订阅的自动更新已关闭");
    expect(quotaNotice.description).toContain("2 个订阅因节点数连续超过配额");
    expect(quotaNotice.description).not.toContain("订阅源失败：");

    const sourceA = disabledSubscription("fetch_failed", "Source A");
    const sourceB = { ...sourceA, id: "sub-3", name: "Source B" };
    const sourceNotice = buildAutoUpdateDisabledNotice([sourceA, sourceB]);
    expect(sourceNotice.description).toContain("2 个订阅因订阅源连续拉取失败");
    expect(sourceNotice.description).not.toContain("节点超额：");
  });
});
