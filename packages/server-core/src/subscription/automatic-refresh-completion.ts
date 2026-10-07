import type { AutomaticRefreshFailureAnalysis, SubscriptionAutoUpdateStateFields } from "./auto-update-state";
import {
  buildAutomaticRefreshAutoUpdateState,
  buildAutomaticRefreshNodeQuotaExceededState,
  buildAutomaticRefreshUnexpectedFailureState,
  markAutomaticRefreshAttempted,
  type AutomaticRefreshAutoUpdateStateResult,
} from "./auto-update-state";
import type { CronSubscriptionUpdateSummary, CronUpdateOutcome } from "./cron-update-summary";
import type { PreparedRefreshCacheResult } from "./refresh-cache-result";

export type AutomaticRefreshCompletionTarget = {
  id: string;
  name: string;
  userId: string;
  username: string | null;
  autoUpdateInterval: number | null;
};

export type AutomaticRefreshCompletionPrepared = {
  requestedHosts: string[];
  refreshResult: PreparedRefreshCacheResult;
  failureState: AutomaticRefreshFailureAnalysis["failureState"];
  failureReason: string;
};

export type AutomaticRefreshCompletionStateHelpers = {
  buildAutomaticRefreshAutoUpdateState: typeof buildAutomaticRefreshAutoUpdateState;
  buildAutomaticRefreshNodeQuotaExceededState: typeof buildAutomaticRefreshNodeQuotaExceededState;
  markAutomaticRefreshAttempted: typeof markAutomaticRefreshAttempted;
};

export type AutomaticRefreshUnexpectedFailureStateHelpers = {
  buildAutomaticRefreshUnexpectedFailureState: typeof buildAutomaticRefreshUnexpectedFailureState;
};

export type AutomaticRefreshCompletionDecision =
  | {
      kind: "all_sources_failed";
      message: string;
      nextAutoUpdateState: AutomaticRefreshAutoUpdateStateResult;
      outcome: CronUpdateOutcome;
    }
  | {
      kind: "empty_result";
      attemptedState: SubscriptionAutoUpdateStateFields;
      outcome: CronUpdateOutcome;
    }
  | {
      kind: "node_quota_exceeded";
      nextAutoUpdateState: AutomaticRefreshAutoUpdateStateResult;
      outcome: CronUpdateOutcome;
    }
  | {
      kind: "success";
      nextAutoUpdateState: AutomaticRefreshAutoUpdateStateResult;
      refreshResult: Extract<PreparedRefreshCacheResult, { ok: true }>;
      outcome: CronUpdateOutcome;
    };

export type AutomaticRefreshUnexpectedFailureCompletion = {
  message: string;
  attemptedState?: SubscriptionAutoUpdateStateFields;
  outcome: CronUpdateOutcome;
};

const defaultCompletionStateHelpers: AutomaticRefreshCompletionStateHelpers = {
  buildAutomaticRefreshAutoUpdateState,
  buildAutomaticRefreshNodeQuotaExceededState,
  markAutomaticRefreshAttempted,
};

const defaultUnexpectedFailureStateHelpers: AutomaticRefreshUnexpectedFailureStateHelpers = {
  buildAutomaticRefreshUnexpectedFailureState,
};

export const AUTOMATIC_REFRESH_ALL_SOURCES_FAILED_MESSAGE =
  "No import sources refreshed; previous snapshot preserved";

export const AUTOMATIC_REFRESH_NODE_QUOTA_EXCEEDED_MESSAGE = "Node quota exceeded";

export function buildAutomaticRefreshSubscriptionSummary(params: {
  target: AutomaticRefreshCompletionTarget;
  hosts: string[];
  nodeCount?: number;
  error?: string;
}): CronSubscriptionUpdateSummary {
  return {
    subscriptionId: params.target.id,
    subscriptionName: params.target.name,
    userId: params.target.userId,
    username: params.target.username,
    hosts: params.hosts,
    ...(typeof params.nodeCount === "number" ? { nodeCount: params.nodeCount } : {}),
    ...(params.error ? { error: params.error } : {}),
  };
}

export function formatAutomaticRefreshResultError(
  target: Pick<AutomaticRefreshCompletionTarget, "id" | "username">,
  message: string
): string {
  return `Subscription ${target.id} (${target.username || "-"}): ${message}`;
}

export function resolveAutomaticRefreshCompletionDecision(params: {
  target: AutomaticRefreshCompletionTarget;
  currentAutoUpdateState: SubscriptionAutoUpdateStateFields;
  prepared: AutomaticRefreshCompletionPrepared;
  attemptedAt: Date;
  maxNodesPerSubscription: number;
  successAttemptedAt?: Date;
  stateHelpers?: AutomaticRefreshCompletionStateHelpers;
}): AutomaticRefreshCompletionDecision {
  const helpers = params.stateHelpers ?? defaultCompletionStateHelpers;
  const refreshResult = params.prepared.refreshResult;

  if (!refreshResult.ok && refreshResult.reason === "all_sources_failed") {
    const message = AUTOMATIC_REFRESH_ALL_SOURCES_FAILED_MESSAGE;
    const nextAutoUpdateState = helpers.buildAutomaticRefreshAutoUpdateState({
      failureState: params.prepared.failureState,
      attemptedAt: params.attemptedAt,
      previousAutoUpdateInterval: params.target.autoUpdateInterval,
      currentState: params.currentAutoUpdateState,
      preserveNodeQuotaFailure: true,
    });

    return {
      kind: "all_sources_failed",
      message,
      nextAutoUpdateState,
      outcome: {
        status: "failed",
        requestedHosts: params.prepared.requestedHosts,
        recordHosts: true,
        resultsError: formatAutomaticRefreshResultError(params.target, message),
        failedSubscription: buildAutomaticRefreshSubscriptionSummary({
          target: params.target,
          hosts: params.prepared.requestedHosts,
          error: message,
        }),
      },
    };
  }

  if (!refreshResult.ok && refreshResult.reason === "empty_result") {
    return {
      kind: "empty_result",
      attemptedState: helpers.markAutomaticRefreshAttempted(params.currentAutoUpdateState, params.attemptedAt),
      outcome: {
        status: "skipped",
        requestedHosts: params.prepared.requestedHosts,
        recordHosts: false,
      },
    };
  }

  if (!refreshResult.ok && refreshResult.reason === "node_quota_exceeded") {
    const maxNodes = refreshResult.maxNodesPerSubscription ?? params.maxNodesPerSubscription;
    const nextAutoUpdateState = helpers.buildAutomaticRefreshNodeQuotaExceededState({
      currentState: params.currentAutoUpdateState,
      attemptedAt: params.attemptedAt,
      actualNodeCount: refreshResult.nodeCount,
      effectiveNodeLimit: maxNodes,
      previousAutoUpdateInterval: params.target.autoUpdateInterval,
    });
    const diagnostic = `${AUTOMATIC_REFRESH_NODE_QUOTA_EXCEEDED_MESSAGE}: actual=${refreshResult.nodeCount}, limit=${maxNodes}, streak=${nextAutoUpdateState.state.nodeQuotaFailureCount}`;
    return {
      kind: "node_quota_exceeded",
      nextAutoUpdateState,
      outcome: {
        status: "failed",
        requestedHosts: params.prepared.requestedHosts,
        recordHosts: false,
        resultsError: `Subscription ${params.target.id}: ${diagnostic}`,
        failedSubscription: buildAutomaticRefreshSubscriptionSummary({
          target: params.target,
          hosts: [],
          nodeCount: refreshResult.nodeCount,
          error: diagnostic,
        }),
      },
    };
  }

  if (!refreshResult.ok) {
    throw new Error(`Unexpected refresh failure reason: ${refreshResult.reason}`);
  }

  const nextAutoUpdateState = helpers.buildAutomaticRefreshAutoUpdateState({
    failureState: params.prepared.failureState,
    attemptedAt: params.successAttemptedAt ?? params.attemptedAt,
    failedAt: params.attemptedAt,
    previousAutoUpdateInterval: params.target.autoUpdateInterval,
  });

  return {
    kind: "success",
    nextAutoUpdateState,
    refreshResult,
    outcome: {
      status: "updated",
      requestedHosts: params.prepared.requestedHosts,
      recordHosts: true,
      updatedSubscription: buildAutomaticRefreshSubscriptionSummary({
        target: params.target,
        hosts: params.prepared.requestedHosts,
        nodeCount: refreshResult.nodeCount,
      }),
    },
  };
}

export function resolveAutomaticRefreshUnexpectedFailureCompletion(params: {
  target: AutomaticRefreshCompletionTarget;
  requestedHosts: string[];
  error: unknown;
  attemptStartedAt: Date | null;
  currentAutoUpdateState?: SubscriptionAutoUpdateStateFields;
  stateHelpers?: AutomaticRefreshUnexpectedFailureStateHelpers;
}): AutomaticRefreshUnexpectedFailureCompletion {
  const helpers = params.stateHelpers ?? defaultUnexpectedFailureStateHelpers;
  const message = params.error instanceof Error ? params.error.message : "Unknown error";
  const attemptedState = params.attemptStartedAt
    ? helpers.buildAutomaticRefreshUnexpectedFailureState(params.attemptStartedAt, params.currentAutoUpdateState)
    : undefined;

  return {
    message,
    ...(attemptedState ? { attemptedState } : {}),
    outcome: {
      status: "failed",
      requestedHosts: params.requestedHosts,
      recordHosts: true,
      resultsError: formatAutomaticRefreshResultError(params.target, message),
      failedSubscription: buildAutomaticRefreshSubscriptionSummary({
        target: params.target,
        hosts: params.requestedHosts,
        error: message,
      }),
    },
  };
}
