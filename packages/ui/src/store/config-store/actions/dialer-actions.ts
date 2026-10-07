import type { ConfigActions, DialerProxyGroup } from "../definitions";
import type { GetState, SetAndGenerateConfig, SetState } from "../store-types";

type DialerActions = Pick<
  ConfigActions,
  | "addDialerProxyGroup"
  | "removeDialerProxyGroup"
  | "updateDialerProxyGroup"
  | "addNodeToDialerGroup"
  | "removeNodeFromDialerGroup"
>;

export function createDialerActions(
  _set: SetState,
  _get: GetState,
  setAndGenerateConfig: SetAndGenerateConfig
): DialerActions {
  return {
    addDialerProxyGroup: (group: Omit<DialerProxyGroup, "id">) => {
      const id = `dialer-${Date.now()}`;
      setAndGenerateConfig((state) => ({
        dialerProxyGroups: [
          ...state.dialerProxyGroups,
          {
            ...group,
            enabled: group.enabled ?? true,
            id,
          },
        ],
      }));
    },

    removeDialerProxyGroup: (id: string) => {
      setAndGenerateConfig((state) => {
        // 分组删除后监听绑定失去目标且无 UI 入口可清理，必须连带移除
        const nextGroupListeners = state.groupListeners.filter(
          (binding) => !(binding && binding.target && binding.target.kind === "dialer" && binding.target.id === id),
        );
        return {
          dialerProxyGroups: state.dialerProxyGroups.filter((g) => g.id !== id),
          ...(nextGroupListeners.length !== state.groupListeners.length
            ? { groupListeners: nextGroupListeners }
            : {}),
        };
      });
    },

    updateDialerProxyGroup: (id: string, group: Partial<DialerProxyGroup>) => {
      setAndGenerateConfig((state) => ({
        dialerProxyGroups: state.dialerProxyGroups.map((g) =>
          g.id === id ? { ...g, ...group } : g
        ),
      }));
    },

    addNodeToDialerGroup: (groupId: string, nodeName: string, isRelay: boolean) => {
      setAndGenerateConfig((state) => ({
        dialerProxyGroups: state.dialerProxyGroups.map((g) => {
          if (g.id !== groupId) return g;
          if (isRelay) {
            // 添加到中转节点列表
            if (g.relayNodes.includes(nodeName)) return g;
            return { ...g, relayNodes: [...g.relayNodes, nodeName] };
          } else {
            // 添加到目标节点列表
            if (g.targetNodes.includes(nodeName)) return g;
            return { ...g, targetNodes: [...g.targetNodes, nodeName] };
          }
        }),
      }));
    },

    removeNodeFromDialerGroup: (groupId: string, nodeName: string, isRelay: boolean) => {
      setAndGenerateConfig((state) => ({
        dialerProxyGroups: state.dialerProxyGroups.map((g) => {
          if (g.id !== groupId) return g;
          if (isRelay) {
            return { ...g, relayNodes: g.relayNodes.filter((n) => n !== nodeName) };
          } else {
            return { ...g, targetNodes: g.targetNodes.filter((n) => n !== nodeName) };
          }
        }),
      }));
    },
  };
}

