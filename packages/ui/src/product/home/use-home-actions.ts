"use client";

import * as React from "react";
import type { SubscriptionSource } from "@subboost/ui/store/config-store";
import type { ParsedNode } from "@subboost/core/types/node";
import { isSourcePendingImport } from "@subboost/ui/product/subscription/source-import-state";
import {
  useProductInteractionAdapter,
  type ProductInteractionResult,
  type ProductMode,
} from "@subboost/ui/product/interactions";
import { getCompactDateStampInBeijing } from "@subboost/core/time/beijing";
import { useConfigStore } from "@subboost/ui/store/config-store";
import { toast } from "@subboost/ui/components/ui/toaster";
import { generateV2rayNSubscription } from "@subboost/core/generator/v2rayn";
import { V2RAYN_EXPORT_NOTICE, type SubscriptionFormat } from "@subboost/core/subscription/output-format";

type UseHomeActionsOptions = {
  generatedYaml: string;
  generatedYamlError: string | null;
  appliedTemplateId: string | null;
  recordConfigDownload?: (templateId: string | null) => void;
  storeSources: SubscriptionSource[];
  nodes: ParsedNode[];
  clearNodes: () => void;
  parseMultipleSources: (sources: SubscriptionSource[]) => Promise<void>;
  generateConfig: () => string;
};

export function useHomeActions({
  generatedYaml,
  generatedYamlError,
  appliedTemplateId,
  recordConfigDownload,
  storeSources,
  nodes,
  clearNodes,
  parseMultipleSources,
  generateConfig,
}: UseHomeActionsOptions) {
  const interactions = useProductInteractionAdapter();

  const handleDownload = React.useCallback((mode: ProductMode, format: SubscriptionFormat = "clash") => {
    if (!generatedYaml || generatedYamlError) return;

    let content = generatedYaml;
    if (format === "v2rayn") {
      try {
        const result = generateV2rayNSubscription(generatedYaml);
        content = result.content;
        toast({
          title: `已导出 ${result.nodeCount} 个 v2rayN 节点${result.skippedNodes.length ? `，跳过 ${result.skippedNodes.length} 个不兼容节点` : ""}`,
          description: `${V2RAYN_EXPORT_NOTICE}${result.providerCount ? ` 已跳过 ${result.providerCount} 个远程节点提供者。` : ""}`,
          variant: result.skippedNodes.length || result.providerCount ? "warning" : "info",
        });
      } catch (error) {
        toast({ title: "无法导出 v2rayN", description: error instanceof Error ? error.message : "请检查节点配置", variant: "destructive" });
        return;
      }
    }

    recordConfigDownload?.(appliedTemplateId);

    const state = useConfigStore.getState();
    interactions.configDownloaded?.({
      mode,
      nodeCount: state.nodes.length,
      templateType: state.template,
    });

    const timestamp = getCompactDateStampInBeijing();
    const filename = format === "v2rayn" ? `v2rayn-subscription-${timestamp}.txt` : `clash-config-${timestamp}.yaml`;
    const mimeType = format === "v2rayn" ? "text/plain;charset=utf-8" : "application/x-yaml;charset=utf-8";
    const file = new File([content], filename, { type: mimeType });
    const url = URL.createObjectURL(file);

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }, [appliedTemplateId, generatedYaml, generatedYamlError, interactions, recordConfigDownload]);

  const trackConfigGenerate = React.useCallback((mode: ProductMode, result: ProductInteractionResult) => {
    const state = useConfigStore.getState();
    const sourceCount = state.sources.filter((source) => source.content.trim()).length;
    interactions.configGenerated?.({
      mode,
      result,
      sourceCount,
      nodeCount: state.nodes.length,
      templateType: state.template,
      hasCustomRules: state.customRules.length > 0,
      hasCustomProxyGroups: state.customProxyGroups.length > 0,
      hasDnsYaml: state.dnsYaml.trim().length > 0,
      hasListenerPorts: Object.values(state.listenerPorts).some((port) => Number.isInteger(port)),
    });
  }, [interactions]);

  const trackSourceImportResults = React.useCallback((mode: ProductMode, importedSources: SubscriptionSource[]) => {
    const state = useConfigStore.getState();
    const latestById = new Map(state.sources.map((source) => [source.id, source]));
    const sourceCount = state.sources.filter((source) => source.content.trim()).length;

    for (const source of importedSources) {
      const latest = latestById.get(source.id) ?? source;
      const hasContent = latest.content.trim().length > 0;
      const result: ProductInteractionResult = !hasContent
        ? "noInput"
        : latest.parsed
          ? "success"
          : latest.error || latest.errorInfo
            ? "runtimeError"
            : "validationError";
      interactions.sourceImported?.({
        mode,
        sourceType: latest.type,
        result,
        sourceCount,
        nodeCount: latest.nodeCount ?? 0,
        usesProxyProvider: Boolean(latest.useProxyProviders),
      });
    }
  }, [interactions]);

  const handleGenerate = React.useCallback(async (mode: ProductMode) => {
    const pendingSources = storeSources.filter(isSourcePendingImport);

    // 如果已有节点，直接生成配置（不自动重新导入，避免覆盖用户改名/删除/排序）
    if (nodes.length > 0) {
      const before = generatedYaml;
      const after = generateConfig();
      const error = useConfigStore.getState().generatedYamlError;
      if (error) {
        trackConfigGenerate(mode, "validationError");
        toast({ title: "基础和 DNS 配置有错误", description: error, variant: "destructive" });
        return;
      }
      const changed = before !== after;

      if (pendingSources.length > 0) {
        trackConfigGenerate(mode, "success");
        toast({
          title: "已生成配置（存在待导入源）",
          description: "当前配置仅基于已导入的节点生成。请先点击每条源右侧 ✅ 导入，再重新生成配置。",
          variant: "info",
        });
        return;
      }

      toast({
        title: changed ? "已生成配置" : "配置未变化",
        variant: changed ? "success" : "info",
      });
      trackConfigGenerate(mode, "success");
      return;
    }

    // 如果没有节点，尝试解析未导入的有效源
    if (pendingSources.length > 0) {
      clearNodes();
      try {
        await parseMultipleSources(pendingSources);
      } catch (error) {
        trackSourceImportResults(mode, pendingSources);
        trackConfigGenerate(mode, "runtimeError");
        throw error;
      }
      trackSourceImportResults(mode, pendingSources);
      const importedCount = useConfigStore.getState().nodes.length;
      toast({
        title: importedCount > 0 ? `已导入并生成配置（${importedCount} 节点）` : "未解析到有效节点",
        variant: importedCount > 0 ? "success" : "warning",
      });
      trackConfigGenerate(mode, importedCount > 0 ? "success" : "runtimeError");
      return;
    }

    // 没有节点且没有可导入源：仍允许生成（可能用于清空/重置）
    const before = generatedYaml;
    const after = generateConfig();
    const error = useConfigStore.getState().generatedYamlError;
    if (error) {
      trackConfigGenerate(mode, "validationError");
      toast({ title: "基础和 DNS 配置有错误", description: error, variant: "destructive" });
      return;
    }
    toast({ title: before !== after ? "已生成配置" : "配置未变化", variant: before !== after ? "success" : "info" });
    trackConfigGenerate(mode, storeSources.some((source) => source.content.trim()) ? "success" : "noInput");
  }, [
    clearNodes,
    generateConfig,
    generatedYaml,
    nodes.length,
    parseMultipleSources,
    storeSources,
    trackConfigGenerate,
    trackSourceImportResults,
  ]);

  const hasValidSources = React.useMemo(() => storeSources.some((s) => s.content.trim()), [storeSources]);

  return { handleDownload, handleGenerate, hasValidSources };
}
