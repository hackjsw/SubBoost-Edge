import { formatNodeNameFromTemplate } from "../node-name-template";
import { buildNodeContentKey, buildScopedNodeIdentityKey } from "../node-identity";
import { stripImportedNodeControlFields } from "./imported-node-controls";
import {
  getNodeOriginName,
  getNodeSourceIds,
  makeUniqueName,
  normalizeNodeOriginName,
  ORIGIN_NAME_KEY,
  SOURCE_IDS_KEY,
  withoutNodeSourceIds,
} from "./node-source-state";
import type { ParsedNode } from "../types/node";

export type SourceRefreshDescriptor = {
  sourceId: string;
  currentTag?: string;
  currentNameTemplate?: string;
  lastTag?: string;
  lastNameTemplate?: string;
  treatAsNewSource?: boolean;
  smartNodeMatchingEnabled?: boolean;
  deletedNodes?: DeletedNodeDescriptor[];
};

export type MergeSourceNodesResult = {
  nodes: ParsedNode[];
  renameMap: Map<string, string>;
};

export type DeletedNodeDescriptor = {
  originName?: unknown;
  name?: unknown;
  node?: ParsedNode;
};

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

// Drops saved nodes the user removed, with the same rules as mergeParsedSourceNodes:
// deletions with a node snapshot match that exact node, while bare origin-name
// markers only apply when that origin name is unique. Deleting one of several
// same-named nodes must not hide the rest of the batch.
export function filterDeletedStoredNodes(
  nodes: ParsedNode[],
  deletedNodeNames: string[],
  deletedNodes: DeletedNodeDescriptor[] = []
): ParsedNode[] {
  const originOf = (node: ParsedNode) => getNodeOriginName(node).trim() || node.name;
  const deletedNames = new Set<string>();
  for (const name of deletedNodeNames) {
    const normalized = normalizeOptionalString(name);
    if (normalized) deletedNames.add(normalized);
  }
  const deletedNodeKeys = new Set<string>();
  for (const item of deletedNodes) {
    const origin = normalizeOptionalString(item?.originName);
    if (!item?.node) {
      if (origin) deletedNames.add(origin);
      continue;
    }
    const node = normalizeNodeOriginName(item.node);
    deletedNodeKeys.add(buildScopedNodeIdentityKey(origin ?? originOf(node), node));
  }
  if (deletedNames.size === 0 && deletedNodeKeys.size === 0) return nodes;

  const originCounts = new Map<string, number>();
  for (const node of nodes) {
    const origin = originOf(node);
    originCounts.set(origin, (originCounts.get(origin) ?? 0) + 1);
  }

  return nodes.filter((node) => {
    const origin = originOf(node);
    if (deletedNodeKeys.has(buildScopedNodeIdentityKey(origin, node))) return false;
    if ((originCounts.get(origin) ?? 0) > 1) return true;
    return !deletedNames.has(origin);
  });
}

function mergePreservedRealityCapabilities(
  stored: Record<string, unknown>,
  fresh: Record<string, unknown>
): Record<string, unknown> {
  const storedReality = stored["reality-opts"];
  const freshReality = fresh["reality-opts"];
  if (
    !storedReality || typeof storedReality !== "object" || Array.isArray(storedReality) ||
    !freshReality || typeof freshReality !== "object" || Array.isArray(freshReality)
  ) {
    return fresh;
  }

  const support = (storedReality as Record<string, unknown>)["support-x25519mlkem768"];
  if (typeof support !== "boolean" || Object.prototype.hasOwnProperty.call(freshReality, "support-x25519mlkem768")) {
    return fresh;
  }

  return {
    ...fresh,
    "reality-opts": {
      ...(freshReality as Record<string, unknown>),
      "support-x25519mlkem768": support,
    },
  };
}

export function prepareSourceParsedNodes(
  nodes: ParsedNode[],
  descriptor: Pick<SourceRefreshDescriptor, "currentTag" | "currentNameTemplate">
): ParsedNode[] {
  const tag = normalizeOptionalString(descriptor.currentTag);
  const template = normalizeOptionalString(descriptor.currentNameTemplate);

  return nodes.map((node) => {
    const sanitizedNode = stripImportedNodeControlFields(node);
    const record = sanitizedNode as unknown as Record<string, unknown>;
    const originName = getNodeOriginName(sanitizedNode).trim();

    const displayName = formatNodeNameFromTemplate({
      originName,
      tag,
      template,
    });

    return ({
      ...record,
      name: displayName || originName,
      [ORIGIN_NAME_KEY]: originName,
    } as unknown as ParsedNode);
  });
}

export function detachSourceNodesFromState(
  stateNodes: ParsedNode[],
  sourceId: string
): MergeSourceNodesResult {
  const removed = new Set([sourceId]);
  const nextNodes: ParsedNode[] = [];

  for (const rawNode of stateNodes) {
    const node = normalizeNodeOriginName(rawNode);
    const next = withoutNodeSourceIds(node, removed);
    if (next) nextNodes.push(next);
  }

  return { nodes: nextNodes, renameMap: new Map<string, string>() };
}

export function mergeParsedSourceNodes(
  stateNodes: ParsedNode[],
  parsedNodes: ParsedNode[],
  deletedNodeNames: string[],
  descriptor: SourceRefreshDescriptor
): MergeSourceNodesResult {
  const sourceId = descriptor.sourceId;
  const lastTag = normalizeOptionalString(descriptor.lastTag);
  const lastNameTemplate = normalizeOptionalString(descriptor.lastNameTemplate);
  const treatAsNewSource = descriptor.treatAsNewSource === true;
  const smartNodeMatchingEnabled = descriptor.smartNodeMatchingEnabled !== false;

  const originOf = (node: ParsedNode) => getNodeOriginName(node).trim() || node.name;
  const keyOf = (node: ParsedNode) => buildScopedNodeIdentityKey(originOf(node), node);

  const mergeUnique = (map: Map<string, string | null>, key: string, value: string) => {
    const existed = map.get(key);
    if (existed === undefined) {
      map.set(key, value);
      return;
    }
    if (existed === value || existed === null) return;
    map.set(key, null);
  };

  const deleted = new Set(
    deletedNodeNames
      .filter((name) => typeof name === "string")
      .map((name) => name.trim())
      .filter(Boolean)
  );
  const deletedNodeKeys = new Set<string>();
  for (const item of Array.isArray(descriptor.deletedNodes) ? descriptor.deletedNodes : []) {
    if (!item?.node) continue;
    const node = normalizeNodeOriginName(item.node);
    const origin = normalizeOptionalString(item.originName) ?? (getNodeOriginName(node).trim() || node.name);
    if (!origin) continue;
    deletedNodeKeys.add(buildScopedNodeIdentityKey(origin, node));
  }

  const freshOriginCounts = new Map<string, number>();
  for (const rawNode of parsedNodes) {
    const node = normalizeNodeOriginName(rawNode);
    const origin = originOf(node);
    if (!origin) continue;
    freshOriginCounts.set(origin, (freshOriginCounts.get(origin) ?? 0) + 1);
  }

  const isDeleted = (node: ParsedNode, originNameRaw: string, displayNameRaw?: string): boolean => {
    const originName = (originNameRaw || "").trim();
    if (!originName) return false;
    if (deletedNodeKeys.has(buildScopedNodeIdentityKey(originName, node))) return true;

    // Legacy deletedNodeNames are only origin/display-name markers. When a source
    // emits many distinct nodes with the same default origin name, a single
    // coarse marker must not hide the entire batch.
    if ((freshOriginCounts.get(originName) ?? 0) > 1) return false;

    if (deleted.has(originName)) return true;

    const displayName = typeof displayNameRaw === "string" ? displayNameRaw.trim() : "";
    if (displayName && deleted.has(displayName)) return true;

    const previousAutoName = formatNodeNameFromTemplate({
      originName,
      tag: lastTag,
      template: lastNameTemplate,
    });
    return Boolean(previousAutoName && deleted.has(previousAutoName));
  };

  const freshOrdered: ParsedNode[] = [];
  const freshSeenKeys = new Set<string>();
  const freshOriginNames = new Set<string>();
  const freshByOrigin = new Map<string, ParsedNode[]>();
  const freshKeyToOriginName = new Map<string, string | null>();
  const freshKeyWithoutServerToOriginName = new Map<string, string | null>();
  const freshKeyWithoutServerPortToOriginName = new Map<string, string | null>();
  const freshKeyWithoutAddressToOriginName = new Map<string, string | null>();

  for (const rawNode of parsedNodes) {
    const node = normalizeNodeOriginName(rawNode);
    const origin = originOf(node);
    if (!origin) continue;
    if (isDeleted(node, origin, node.name)) continue;

    const key = keyOf(node);
    if (freshSeenKeys.has(key)) continue;
    freshSeenKeys.add(key);

    freshOrdered.push(node);
    freshOriginNames.add(origin);
    const list = freshByOrigin.get(origin) ?? [];
    list.push(node);
    freshByOrigin.set(origin, list);
    mergeUnique(freshKeyToOriginName, buildNodeContentKey(node), origin);
    mergeUnique(freshKeyWithoutServerToOriginName, buildNodeContentKey(node, { ignoreServer: true }), origin);
    mergeUnique(
      freshKeyWithoutServerPortToOriginName,
      buildNodeContentKey(node, { ignoreServer: true, ignorePort: true }),
      origin
    );
    mergeUnique(
      freshKeyWithoutAddressToOriginName,
      buildNodeContentKey(node, {
        ignoreServer: true,
        ignorePort: true,
        ignoreSni: true,
        ignoreServername: true,
      }),
      origin
    );
  }

  const resolve = (value: string | null | undefined) =>
    typeof value === "string" && value.trim() ? value.trim() : null;

  const inferMatchingOriginName = (node: ParsedNode): string | null => {
    if (!smartNodeMatchingEnabled) return null;

    const inferred =
      resolve(freshKeyToOriginName.get(buildNodeContentKey(node))) ??
      resolve(freshKeyWithoutServerToOriginName.get(buildNodeContentKey(node, { ignoreServer: true }))) ??
      resolve(
        freshKeyWithoutServerPortToOriginName.get(
          buildNodeContentKey(node, { ignoreServer: true, ignorePort: true })
        )
      ) ??
      resolve(
        freshKeyWithoutAddressToOriginName.get(
          buildNodeContentKey(node, {
            ignoreServer: true,
            ignorePort: true,
            ignoreSni: true,
            ignoreServername: true,
          })
        )
      );
    return inferred && freshOriginNames.has(inferred) ? inferred : null;
  };

  const isUserRenamed = (nodeName: string, originName: string) => {
    if (treatAsNewSource) return false;
    const previousAutoName = formatNodeNameFromTemplate({
      originName,
      tag: lastTag,
      template: lastNameTemplate,
    });
    return nodeName !== previousAutoName;
  };

  const hasExplicitOriginName = (node: ParsedNode): boolean => {
    const record = node as unknown as Record<string, unknown>;
    return typeof record[ORIGIN_NAME_KEY] === "string" && String(record[ORIGIN_NAME_KEY]).trim().length > 0;
  };

  const resolveOriginName = (
    node: ParsedNode,
    options: { allowDisplayNameFallback: boolean }
  ): string | null => {
    const record = node as unknown as Record<string, unknown>;
    const originRaw =
      typeof record[ORIGIN_NAME_KEY] === "string" && String(record[ORIGIN_NAME_KEY]).trim()
        ? String(record[ORIGIN_NAME_KEY]).trim()
        : "";

    const inferred = inferMatchingOriginName(node);
    if (originRaw && freshOriginNames.has(originRaw)) return originRaw;
    if (inferred) return inferred;

    const candidate = (node.name || "").trim();
    if (options.allowDisplayNameFallback && candidate && freshOriginNames.has(candidate)) {
      const sameTypeExists = freshOrdered.some((item) => originOf(item) === candidate && item.type === node.type);
      if (sameTypeExists) return candidate;
    }

    return originRaw ? originRaw : null;
  };

  const buildNextSourceIds = (existingSourceIds: string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (raw: string) => {
      const sid = (raw || "").trim();
      if (!sid || seen.has(sid)) return;
      seen.add(sid);
      out.push(sid);
    };
    for (const id of existingSourceIds) push(id);
    push(sourceId);
    return out;
  };

  const mergeNodeWithFresh = (params: {
    stored: ParsedNode;
    fresh: ParsedNode;
    originName: string;
    desiredName: string;
    extraSourceIds: string[];
  }): ParsedNode => {
    const storedRecord = params.stored as unknown as Record<string, unknown>;
    const freshRecord = params.fresh as unknown as Record<string, unknown>;
    const preservedExtra = Object.fromEntries(
      Object.entries(storedRecord).filter(
        ([key]) => key.startsWith("_") && key !== ORIGIN_NAME_KEY && key !== SOURCE_IDS_KEY
      )
    );
    const freshWithPreservedCapabilities = mergePreservedRealityCapabilities(storedRecord, freshRecord);

    return ({
      ...freshWithPreservedCapabilities,
      ...preservedExtra,
      name: params.desiredName,
      [ORIGIN_NAME_KEY]: params.originName,
      [SOURCE_IDS_KEY]: buildNextSourceIds(params.extraSourceIds),
    } as unknown as ParsedNode);
  };

  const consumedFreshKeys = new Set<string>();
  const originConsumed = new Map<string, number>();
  const takeFresh = (originName: string): ParsedNode | null => {
    const list = freshByOrigin.get(originName);
    if (!list || list.length === 0) return null;
    const idx = originConsumed.get(originName) ?? 0;
    if (idx >= list.length) return null;
    originConsumed.set(originName, idx + 1);
    const fresh = list[idx];
    consumedFreshKeys.add(keyOf(fresh));
    return fresh;
  };

  const removed = new Set([sourceId]);
  const baseNodes: ParsedNode[] = [];
  const baseOldNames: Array<string | null> = [];
  const baseFixed: boolean[] = [];
  let hadExistingSourceNodes = false;

  const pushPlanned = (node: ParsedNode, oldName: string | null, fixedName: boolean) => {
    baseNodes.push(node);
    baseOldNames.push(oldName);
    baseFixed.push(fixedName);
  };

  for (const rawNode of stateNodes) {
    const explicitOriginName = hasExplicitOriginName(rawNode);
    const node = normalizeNodeOriginName(rawNode);
    const sourceIds = getNodeSourceIds(node);
    const allowDisplayNameFallback = smartNodeMatchingEnabled || !explicitOriginName;

    if (sourceIds.includes(sourceId)) {
      hadExistingSourceNodes = true;
      const originName = resolveOriginName(node, { allowDisplayNameFallback }) ?? originOf(node);
      const fresh = originName ? takeFresh(originName) : null;

      const base = withoutNodeSourceIds(node, removed);
      if (!fresh) {
        if (base) pushPlanned(base, base.name, true);
        continue;
      }

      const keepUserName = originName ? isUserRenamed(node.name, originName) : false;
      const desiredName = keepUserName ? node.name : fresh.name;
      const extraIds = base ? getNodeSourceIds(base) : sourceIds.filter((id) => id !== sourceId);

      const merged = mergeNodeWithFresh({
        stored: node,
        fresh,
        originName: originName || originOf(fresh),
        desiredName,
        extraSourceIds: extraIds,
      });
      pushPlanned(merged, node.name, keepUserName);
      continue;
    }

    if (sourceIds.length === 0 && freshOriginNames.size > 0) {
      const originName = resolveOriginName(node, { allowDisplayNameFallback });
      if (originName && freshOriginNames.has(originName)) {
        hadExistingSourceNodes = true;
        const fresh = takeFresh(originName);
        if (!fresh) {
          continue;
        }

        const keepUserName = isUserRenamed(node.name, originName);
        const desiredName = keepUserName ? node.name : fresh.name;
        const merged = mergeNodeWithFresh({
          stored: node,
          fresh,
          originName,
          desiredName,
          extraSourceIds: [],
        });
        pushPlanned(merged, node.name, keepUserName);
        continue;
      }
    }

    pushPlanned(node, node.name, true);
  }

  const baseKeyToIndex = new Map<string, number>();
  baseNodes.forEach((node, idx) => baseKeyToIndex.set(keyOf(node), idx));

  const newNodes: ParsedNode[] = [];
  for (const node of freshOrdered) {
    const key = keyOf(node);
    if (consumedFreshKeys.has(key)) continue;

    const existingIndex = smartNodeMatchingEnabled ? baseKeyToIndex.get(key) : undefined;
    if (existingIndex !== undefined) {
      const existing = baseNodes[existingIndex];
      baseNodes[existingIndex] = mergeNodeWithFresh({
        stored: existing,
        fresh: node,
        originName: originOf(node),
        desiredName: existing.name,
        extraSourceIds: getNodeSourceIds(existing),
      });
      continue;
    }

    const record = node as unknown as Record<string, unknown>;
    const originName = originOf(node);
    newNodes.push(
      ({
        ...record,
        [ORIGIN_NAME_KEY]: originName,
        [SOURCE_IDS_KEY]: [sourceId],
      } as unknown as ParsedNode)
    );
  }

  const insertionIndex = (() => {
    if (!hadExistingSourceNodes) return baseNodes.length;
    for (let i = baseNodes.length - 1; i >= 0; i -= 1) {
      if (getNodeSourceIds(baseNodes[i]).includes(sourceId)) return i + 1;
    }
    return baseNodes.length;
  })();

  const combinedNodes =
    newNodes.length > 0
      ? [...baseNodes.slice(0, insertionIndex), ...newNodes, ...baseNodes.slice(insertionIndex)]
      : baseNodes;
  const combinedOldNames =
    newNodes.length > 0
      ? [...baseOldNames.slice(0, insertionIndex), ...new Array(newNodes.length).fill(null), ...baseOldNames.slice(insertionIndex)]
      : baseOldNames;
  const combinedFixed =
    newNodes.length > 0
      ? [...baseFixed.slice(0, insertionIndex), ...new Array(newNodes.length).fill(false), ...baseFixed.slice(insertionIndex)]
      : baseFixed;

  const renameMap = new Map<string, string>();
  const usedNames = new Set<string>();
  const nextNodes = combinedNodes.map((node) => node);

  const setNodeName = (idx: number, nextName: string) => {
    const node = nextNodes[idx];
    if (node.name === nextName) return;
    const record = node as unknown as Record<string, unknown>;
    nextNodes[idx] = ({ ...record, name: nextName } as unknown as ParsedNode);
  };

  for (let i = 0; i < nextNodes.length; i += 1) {
    if (!combinedFixed[i]) continue;
    const desired = nextNodes[i].name;
    const finalName = makeUniqueName(desired, usedNames);
    usedNames.add(finalName);
    setNodeName(i, finalName);
    const oldName = combinedOldNames[i];
    if (oldName && finalName !== oldName) renameMap.set(oldName, finalName);
  }

  for (let i = 0; i < nextNodes.length; i += 1) {
    if (combinedFixed[i]) continue;
    const desired = nextNodes[i].name;
    const finalName = makeUniqueName(desired, usedNames);
    usedNames.add(finalName);
    setNodeName(i, finalName);
    const oldName = combinedOldNames[i];
    if (oldName && finalName !== oldName) renameMap.set(oldName, finalName);
  }

  return { nodes: nextNodes, renameMap };
}
