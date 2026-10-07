import type { GroupListenerTarget } from "@subboost/core/types/config";
import type { ConfigActions } from "../definitions";
import type { GetState, SetAndGenerateConfig, SetState } from "../store-types";

type GroupListenerActions = Pick<ConfigActions, "setGroupListener">;

function isSameTarget(a: GroupListenerTarget, b: GroupListenerTarget): boolean {
  return a.kind === b.kind && a.id === b.id;
}

export function createGroupListenerActions(
  _set: SetState,
  _get: GetState,
  setAndGenerateConfig: SetAndGenerateConfig
): GroupListenerActions {
  return {
    // 每个策略组最多一个监听端口：config 为 null 时移除，否则新建或原位更新
    setGroupListener: (target, config) => {
      setAndGenerateConfig((state) => {
        const existing = state.groupListeners.filter((b) => b && b.target && isSameTarget(b.target, target));
        const rest = state.groupListeners.filter((b) => !(b && b.target && isSameTarget(b.target, target)));

        if (config === null) {
          if (existing.length === 0) return {};
          return { groupListeners: rest };
        }

        const binding = {
          id: existing[0]?.id ?? `group-listener-${Date.now()}`,
          target,
          port: config.port,
          ...(config.enabled === false ? { enabled: false as const } : {}),
          ...(config.allowLan === true ? { allowLan: true as const } : {}),
        };

        // 原位更新保持顺序稳定；同目标只保留一条
        if (existing.length > 0) {
          let replaced = false;
          const next = state.groupListeners.filter((b) => {
            if (b && b.target && isSameTarget(b.target, target)) {
              if (replaced) return false;
              replaced = true;
            }
            return true;
          });
          return {
            groupListeners: next.map((b) =>
              b && b.target && isSameTarget(b.target, target) ? binding : b
            ),
          };
        }
        return { groupListeners: [...state.groupListeners, binding] };
      });
    },
  };
}
