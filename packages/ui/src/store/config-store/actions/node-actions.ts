import type { ParsedNode } from "@subboost/core/types/node";
import { formatNodeNameFromTemplate } from "@subboost/core/node-name-template";
import type { ConfigActions } from "../definitions";
import { makeUniqueName } from "../definitions";
import type { GetState, SetAndGenerateConfig, SetState } from "../store-types";

type NodeActions = Pick<
  ConfigActions,
  | "clearNodes"
  | "removeNode"
  | "restoreDeletedNode"
  | "restoreNodeName"
  | "moveNode"
  | "setNodeOrder"
  | "renameNode"
  | "bulkRenameNodes"
  | "setListenerPort"
  | "bulkSetListenerPorts"
>;

export function createNodeActions(
  set: SetState,
  _get: GetState,
  setAndGenerateConfig: SetAndGenerateConfig
): NodeActions {
  return {
    clearNodes: () => {
      set({
        nodes: [],
        deletedNodeNames: [],
        deletedNodes: [],
        parseErrors: [],
        generatedYaml: "",
        generatedYamlError: null,
        listenerPorts: {},
      });
    },

    removeNode: (name: string) => {
      setAndGenerateConfig((state) => {
        const target = state.nodes.find((n) => n.name === name);
        const originName =
          target &&
          typeof (target as unknown as Record<string, unknown>)["_originName"] ===
            "string"
            ? String((target as unknown as Record<string, unknown>)["_originName"]).trim()
            : name.trim();

        const deleted = new Set(state.deletedNodeNames);
        if (originName) deleted.add(originName);

        const displayName = target?.name || name;
        const nodeForRestore = target ? (target as unknown as ParsedNode) : undefined;
        const savedListenerPort =
          typeof state.listenerPorts[name] === "number"
            ? state.listenerPorts[name]
            : undefined;

        const relayGroupIds: string[] = [];
        const targetGroupIds: string[] = [];
        for (const g of state.dialerProxyGroups) {
          if (g.relayNodes.includes(name)) relayGroupIds.push(g.id);
          if (g.targetNodes.includes(name)) targetGroupIds.push(g.id);
        }
        const deletedNodes = [
          ...state.deletedNodes.filter(
            (n) =>
              n &&
              typeof n.originName === "string" &&
              (n.originName !== originName || n.name !== displayName)
          ),
          {
            originName,
            name: displayName,
            node: nodeForRestore,
            listenerPort: savedListenerPort,
            dialerRelayGroupIds: relayGroupIds,
            dialerTargetGroupIds: targetGroupIds,
          },
        ];
        const { [name]: _removed, ...restPorts } = state.listenerPorts;

        return {
          nodes: state.nodes.filter((n) => n.name !== name),
          deletedNodeNames: Array.from(deleted),
          deletedNodes,
          listenerPorts: restPorts,
          dialerProxyGroups: state.dialerProxyGroups.map((g) => ({
            ...g,
            relayNodes: g.relayNodes.filter((n) => n !== name),
            targetNodes: g.targetNodes.filter((n) => n !== name),
          })),
        };
      });
    },

    restoreDeletedNode: (originName: string) => {
      const target = originName.trim();
      if (!target) return;

      setAndGenerateConfig((state) => {
        const nextDeletedNodeNames = state.deletedNodeNames.filter((n) => n !== target);
        const restoring = state.deletedNodes.find((n) => n && n.originName === target);
        const remainingDeletedNodes = state.deletedNodes.filter((n) => n && n.originName !== target);

        // 如果没有缓存节点对象：仅取消删除标记（下次重新导入时恢复）
        if (!restoring?.node) {
          if (
            nextDeletedNodeNames.length === state.deletedNodeNames.length &&
            remainingDeletedNodes.length === state.deletedNodes.length
          ) {
            return state;
          }
          return {
            deletedNodeNames: nextDeletedNodeNames,
            deletedNodes: remainingDeletedNodes,
          };
        }

        // 避免重复添加（如果节点已存在）
        const alreadyExists = state.nodes.some((n) => {
          const record = n as unknown as Record<string, unknown>;
          const origin =
            typeof record["_originName"] === "string" && record["_originName"].trim()
              ? String(record["_originName"]).trim()
              : n.name;
          return origin === target;
        });
        if (alreadyExists) {
          return {
            deletedNodeNames: nextDeletedNodeNames,
            deletedNodes: remainingDeletedNodes,
          };
        }

        const usedNames = new Set(state.nodes.map((n) => n.name));
        const restoredName = makeUniqueName(restoring.node.name, usedNames);
        const restoredNodeRecord = restoring.node as unknown as Record<string, unknown>;
        const restoredNode =
          restoredName === restoring.node.name
            ? restoring.node
            : ({ ...restoredNodeRecord, name: restoredName } as unknown as ParsedNode);

        const nextNodes = [...state.nodes, restoredNode];

        const nextListenerPorts = (() => {
          if (typeof restoring.listenerPort !== "number") return state.listenerPorts;
          return { ...state.listenerPorts, [restoredNode.name]: restoring.listenerPort };
        })();

        const nextDialerProxyGroups = state.dialerProxyGroups.map((g) => {
          const shouldAddRelay = restoring.dialerRelayGroupIds?.includes(g.id);
          const shouldAddTarget = restoring.dialerTargetGroupIds?.includes(g.id);
          if (!shouldAddRelay && !shouldAddTarget) return g;
          return {
            ...g,
            relayNodes: shouldAddRelay
              ? Array.from(new Set([...g.relayNodes, restoredNode.name]))
              : g.relayNodes,
            targetNodes: shouldAddTarget
              ? Array.from(new Set([...g.targetNodes, restoredNode.name]))
              : g.targetNodes,
          };
        });

        return {
          nodes: nextNodes,
          deletedNodeNames: nextDeletedNodeNames,
          deletedNodes: remainingDeletedNodes,
          listenerPorts: nextListenerPorts,
          dialerProxyGroups: nextDialerProxyGroups,
        };
      });
    },

    restoreNodeName: (nodeName: string) => {
      setAndGenerateConfig((state) => {
        const target = state.nodes.find((n) => n.name === nodeName);
        if (!target) return state;
        const record = target as unknown as Record<string, unknown>;
        const originName =
          typeof record["_originName"] === "string" && record["_originName"].trim()
            ? String(record["_originName"]).trim()
            : "";
        if (!originName || originName === nodeName) return state;

        const sourceIds = (() => {
          const raw = record["_sourceIds"];
          if (!Array.isArray(raw)) return [];
          return raw.filter(
            (id): id is string => typeof id === "string" && id.trim() !== ""
          );
        })();
        const primarySource =
          sourceIds.length > 0
            ? state.sources.find((s) => sourceIds.includes(s.id))
            : undefined;
        const tag =
          primarySource?.lastParsedTag?.trim() ||
          primarySource?.tag?.trim() ||
          "";
        const template =
          primarySource?.lastParsedNameTemplate?.trim() ||
          primarySource?.nameTemplate?.trim();

        const restoredName = tag
          ? formatNodeNameFromTemplate({ originName, tag, template })
          : originName;

        const usedNames = new Set(
          state.nodes.map((n) => n.name).filter((n) => n !== nodeName)
        );
        const finalName = makeUniqueName(restoredName, usedNames);
        const replaceName = (list: string[]) => {
          const out: string[] = [];
          const seen = new Set<string>();
          for (const item of list) {
            const next = item === nodeName ? finalName : item;
            if (seen.has(next)) continue;
            seen.add(next);
            out.push(next);
          }
          return out;
        };

        return {
          nodes: state.nodes.map((n) => {
            if (n.name !== nodeName) return n;
            const rec = n as unknown as Record<string, unknown>;
            return { ...rec, name: finalName, _originName: originName } as unknown as ParsedNode;
          }),
          listenerPorts: (() => {
            const port = state.listenerPorts[nodeName];
            if (typeof port !== "number") return state.listenerPorts;
            const { [nodeName]: _removed, ...rest } = state.listenerPorts;
            return { ...rest, [finalName]: port };
          })(),
          dialerProxyGroups: state.dialerProxyGroups.map((g) => ({
            ...g,
            relayNodes: replaceName(g.relayNodes),
            targetNodes: replaceName(g.targetNodes),
          })),
        };
      });
    },

    moveNode: (nodeName: string, direction: "up" | "down") => {
      setAndGenerateConfig((state) => {
        const from = state.nodes.findIndex((n) => n.name === nodeName);
        if (from < 0) return state;
        const to = direction === "up" ? from - 1 : from + 1;
        if (to < 0 || to >= state.nodes.length) return state;
        const next = state.nodes.slice();
        const [item] = next.splice(from, 1);
        next.splice(to, 0, item);
        return { nodes: next };
      });
    },

    setNodeOrder: (nodeName: string, order: number, scopeNodeNames?: string[]) => {
      setAndGenerateConfig((state) => {
        if (!Number.isFinite(order)) return state;

        if (Array.isArray(scopeNodeNames)) {
          const scope = new Set(
            scopeNodeNames.filter(
              (name): name is string => typeof name === "string" && name.trim() !== ""
            )
          );
          if (!scope.has(nodeName)) return state;

          const scopedNodes = state.nodes.filter((node) => scope.has(node.name));
          const from = scopedNodes.findIndex((node) => node.name === nodeName);
          if (from < 0) return state;
          const to = Math.max(
            0,
            Math.min(scopedNodes.length - 1, Math.floor(order) - 1)
          );
          if (to === from) return state;

          const reorderedScopedNodes = scopedNodes.slice();
          const [item] = reorderedScopedNodes.splice(from, 1);
          reorderedScopedNodes.splice(to, 0, item);

          let scopedIndex = 0;
          return {
            nodes: state.nodes.map((node) => {
              if (!scope.has(node.name)) return node;
              const replacement = reorderedScopedNodes[scopedIndex];
              scopedIndex += 1;
              return replacement ?? node;
            }),
          };
        }

        const from = state.nodes.findIndex((n) => n.name === nodeName);
        if (from < 0) return state;
        const to = Math.max(0, Math.min(state.nodes.length - 1, Math.floor(order) - 1));
        if (to === from) return state;
        const next = state.nodes.slice();
        const [item] = next.splice(from, 1);
        next.splice(to, 0, item);
        return { nodes: next };
      });
    },

    renameNode: (oldName: string, newName: string) => {
      if (!newName.trim() || oldName === newName) return;
      setAndGenerateConfig((state) => {
        const usedNames = new Set(
          state.nodes.map((n) => n.name).filter((n) => n !== oldName)
        );
        const finalName = makeUniqueName(newName.trim(), usedNames);
        const replaceName = (list: string[]) => {
          const out: string[] = [];
          const seen = new Set<string>();
          for (const item of list) {
            const next = item === oldName ? finalName : item;
            if (seen.has(next)) continue;
            seen.add(next);
            out.push(next);
          }
          return out;
        };
        return {
          nodes: state.nodes.map((n) => {
            if (n.name !== oldName) return n;
            const record = n as unknown as Record<string, unknown>;
            const originName =
              typeof record["_originName"] === "string" && record["_originName"].trim()
                ? String(record["_originName"])
                : oldName;
            return { ...record, name: finalName, _originName: originName } as unknown as ParsedNode;
          }),
          listenerPorts: (() => {
            const port = state.listenerPorts[oldName];
            if (typeof port !== "number") return state.listenerPorts;
            const { [oldName]: _removed, ...rest } = state.listenerPorts;
            return { ...rest, [finalName]: port };
          })(),
          dialerProxyGroups: state.dialerProxyGroups.map((g) => ({
            ...g,
            relayNodes: replaceName(g.relayNodes),
            targetNodes: replaceName(g.targetNodes),
          })),
        };
      });
    },

    bulkRenameNodes: (renames: Array<{ oldName: string; newName: string }>) => {
      if (!Array.isArray(renames) || renames.length === 0) return;

      const requested = new Map<string, string>();
      for (const item of renames) {
        if (!item) continue;
        const oldName = typeof item.oldName === "string" ? item.oldName.trim() : "";
        const newName = typeof item.newName === "string" ? item.newName.trim() : "";
        if (!oldName || !newName) continue;
        if (oldName === newName) continue;
        requested.set(oldName, newName);
      }
      if (requested.size === 0) return;

      setAndGenerateConfig((state) => {
        const existingNames = new Set(state.nodes.map((n) => n.name));
        const pending = Array.from(requested.entries()).filter(([oldName]) =>
          existingNames.has(oldName)
        );
        if (pending.length === 0) return state;

        pending.sort((a, b) => a[0].localeCompare(b[0]));

        const usedNames = new Set<string>(
          state.nodes.map((n) => n.name).filter((n) => !requested.has(n))
        );

        const finalMap = new Map<string, string>();
        for (const [oldName, desired] of pending) {
          const finalName = makeUniqueName(desired, usedNames);
          usedNames.add(finalName);
          finalMap.set(oldName, finalName);
        }

        const replaceName = (list: string[]) => {
          const out: string[] = [];
          const seen = new Set<string>();
          for (const item of list) {
            const next = finalMap.get(item) ?? item;
            if (seen.has(next)) continue;
            seen.add(next);
            out.push(next);
          }
          return out;
        };

        const nextNodes = state.nodes.map((n) => {
          const next = finalMap.get(n.name);
          if (!next) return n;
          const record = n as unknown as Record<string, unknown>;
          const originName =
            typeof record["_originName"] === "string" && record["_originName"].trim()
              ? String(record["_originName"])
              : n.name;
          return { ...record, name: next, _originName: originName } as unknown as ParsedNode;
        });

        const nextListenerPorts = (() => {
          if (!state.listenerPorts || typeof state.listenerPorts !== "object") return state.listenerPorts;
          let changed = false;
          const out: Record<string, number> = { ...state.listenerPorts };
          finalMap.forEach((nextName, oldName) => {
            const port = out[oldName];
            if (typeof port !== "number") return;
            delete out[oldName];
            out[nextName] = port;
            changed = true;
          });
          return changed ? out : state.listenerPorts;
        })();

        const nextDialerProxyGroups = state.dialerProxyGroups.map((g) => ({
          ...g,
          relayNodes: replaceName(g.relayNodes),
          targetNodes: replaceName(g.targetNodes),
        }));

        return {
          nodes: nextNodes,
          listenerPorts: nextListenerPorts,
          dialerProxyGroups: nextDialerProxyGroups,
        };
      });
    },

    setListenerPort: (nodeName: string, port: number | null) => {
      const key = nodeName.trim();
      if (!key) return;

      setAndGenerateConfig((state) => {
        if (port === null) {
          if (!(key in state.listenerPorts)) return state;
          const { [key]: _removed, ...rest } = state.listenerPorts;
          return { listenerPorts: rest };
        }

        if (!Number.isInteger(port) || port < 1 || port > 65535) return state;
        if (state.listenerPorts[key] === port) return state;
        return { listenerPorts: { ...state.listenerPorts, [key]: port } };
      });
    },

    bulkSetListenerPorts: (patch: Record<string, number | null>) => {
      if (!patch || typeof patch !== "object") return;

      setAndGenerateConfig((state) => {
        let changed = false;
        const normalized: Record<string, number | null> = {};
        for (const [rawName, rawValue] of Object.entries(patch)) {
          const name = typeof rawName === "string" ? rawName.trim() : "";
          if (!name) continue;
          if (rawValue === null) normalized[name] = null;
          else if (typeof rawValue === "number") normalized[name] = rawValue;
        }
        const normalizedNames = Object.keys(normalized);
        if (normalizedNames.length === 0) return state;

        const next: Record<string, number> = { ...state.listenerPorts };

        // 先移除将被覆盖/清空的节点，避免旧端口占用影响后续校验
        for (const name of normalizedNames) {
          if (name in next) {
            delete next[name];
            changed = true;
          }
        }

        const usedPorts: Record<string, string> = {};
        for (const [name, port] of Object.entries(next)) {
          if (typeof port !== "number") continue;
          usedPorts[String(port)] = name;
        }

        for (const [name, value] of Object.entries(normalized)) {
          if (value === null) continue;
          const port = value;
          if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
          if (usedPorts[String(port)]) continue;
          next[name] = port;
          usedPorts[String(port)] = name;
          changed = true;
        }

        return changed ? { listenerPorts: next } : state;
      });
    },
  };
}
