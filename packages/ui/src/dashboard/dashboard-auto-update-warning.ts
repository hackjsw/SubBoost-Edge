import {
  AUTO_UPDATE_NODE_QUOTA_DISABLED_REASON,
  AUTO_UPDATE_NODE_QUOTA_FAILURE_THRESHOLD,
} from "@subboost/core/subscription/auto-update-failure-policy";
import type { Subscription, SubscriptionAutoUpdateState } from "./dashboard-types";

function formatQuotaFact(value: number | null): string {
  return value === null ? "未知" : String(value);
}

export function createResetDashboardAutoUpdateState(): SubscriptionAutoUpdateState {
  return {
    externalFailureCount: 0,
    failureSourceState: null,
    lastFailedAt: null,
    lastAttemptedAt: null,
    nodeQuotaFailureCount: 0,
    lastNodeQuotaExceededAt: null,
    lastNodeQuotaActual: null,
    lastNodeQuotaLimit: null,
    disabledAt: null,
    disabledReason: null,
    disabledPreviousInterval: null,
  };
}

export function buildNodeQuotaWarning(state: SubscriptionAutoUpdateState): string | null {
  const count = state.nodeQuotaFailureCount ?? 0;
  if (count <= 0) return null;
  return `节点数超出配额：实际 ${formatQuotaFact(state.lastNodeQuotaActual ?? null)}，额度 ${formatQuotaFact(state.lastNodeQuotaLimit ?? null)}（连续 ${count}/${AUTO_UPDATE_NODE_QUOTA_FAILURE_THRESHOLD} 次）`;
}

export function isNodeQuotaAutoUpdateDisabled(state: SubscriptionAutoUpdateState): boolean {
  return Boolean(state.disabledAt) && state.disabledReason === AUTO_UPDATE_NODE_QUOTA_DISABLED_REASON;
}

export function buildQuotaDisabledRecoveryText(state: SubscriptionAutoUpdateState): string {
  return `${buildNodeQuotaWarning(state) ?? AUTO_UPDATE_NODE_QUOTA_DISABLED_REASON}。当前可用配置仍会保留；请减少导入节点或订阅源，或提高节点额度后再重新开启自动更新。`;
}

export function buildAutoUpdateDisabledNotice(subscriptions: Subscription[]): {
  title: string;
  description: string;
} {
  const first = subscriptions[0];
  if (!first) return { title: "自动更新已关闭", description: "" };
  const title = subscriptions.length === 1 ? "自动更新已关闭" : `${subscriptions.length} 个订阅的自动更新已关闭`;
  if (subscriptions.length > 1) {
    const quotaDisabled = subscriptions.filter((subscription) =>
      isNodeQuotaAutoUpdateDisabled(subscription.autoUpdateState)
    );
    const sourceDisabled = subscriptions.filter((subscription) =>
      !isNodeQuotaAutoUpdateDisabled(subscription.autoUpdateState)
    );
    const lead = [
      quotaDisabled.length > 0 ? `${quotaDisabled.length} 个订阅因节点数连续超过配额而关闭自动更新` : null,
      sourceDisabled.length > 0 ? `${sourceDisabled.length} 个订阅因订阅源连续拉取失败而关闭自动更新` : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join("；");
    const recovery = [
      quotaDisabled[0]
        ? `节点超额：${buildQuotaDisabledRecoveryText(quotaDisabled[0].autoUpdateState)}`
        : null,
      sourceDisabled.length > 0
        ? "订阅源失败：当前可用配置仍会保留；请检查订阅 URL 是否失效、是否限制服务端/代理 IP，必要时重新复制订阅链接后再开启自动更新。"
        : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n");
    return { title, description: `${lead}。\n${recovery}` };
  }

  const quotaDisabled = isNodeQuotaAutoUpdateDisabled(first.autoUpdateState);
  const lead = quotaDisabled
    ? `「${first.name}」因节点数连续超过配额，系统已关闭自动更新。`
    : `「${first.name}」的订阅源连续拉取失败，系统已关闭自动更新。`;
  const recovery = quotaDisabled
    ? buildQuotaDisabledRecoveryText(first.autoUpdateState)
    : "当前可用配置仍会保留；请检查订阅 URL 是否失效、是否限制服务端/代理 IP，必要时重新复制订阅链接后再开启自动更新。";
  return { title, description: `${lead}\n${recovery}` };
}
