"use client";

import * as React from "react";
import { AlertTriangle, ChevronDown, SlidersHorizontal } from "lucide-react";
import { getTemplateList } from "@subboost/core/templates";
import type { TemplateType } from "@subboost/core/types/config";
import { DEFAULT_BASE_CONFIG_YAML } from "@subboost/core/config/defaults";
import type {
  ClashConversionProfile,
  ClashConversionProfileId,
} from "@subboost/core/subscription/clash-conversion-profiles";
import { confirmDialog } from "@subboost/ui/components/ui/confirm-dialog";
import { useConfigStore } from "@subboost/ui/store/config-store";
import { NodeManagementSection } from "@subboost/ui/product/converter/advanced-mode/sections/node-management-section";
import { DialerProxyGroupsSection } from "@subboost/ui/product/converter/advanced-mode/sections/dialer-proxy-groups-section";
import { ProxyGroupsSection } from "@subboost/ui/product/converter/advanced-mode/sections/proxy-groups-section";
import { RulesManagementSection } from "@subboost/ui/product/converter/advanced-mode/sections/rules-management-section";
import { DnsSection } from "@subboost/ui/product/converter/advanced-mode/sections/dns-section";

type SectionKey = "filter" | "chain" | "proxy" | "rules" | "dns";

type Props = {
  conversionProfiles: readonly ClashConversionProfile[];
  conversionProfileId: ClashConversionProfileId;
  setConversionProfileId: (value: ClashConversionProfileId) => void;
};

const TEMPLATES = getTemplateList();

type ConfigStoreState = ReturnType<typeof useConfigStore.getState>;

// What a template switch resets.
function hasRuleCustomizations(state: ConfigStoreState = useConfigStore.getState()): boolean {
  return (
    state.customRules.length > 0 ||
    state.customProxyGroups.length > 0 ||
    state.customRuleSets.length > 0 ||
    (state.dialerProxyGroups?.length ?? 0) > 0 ||
    Object.keys(state.builtinRuleEdits ?? {}).length > 0
  );
}

// Anything edited inside the customize panel. Manual renames are not detected:
// name templates also change node names, so they cannot be told apart.
function hasCustomizations(state: ConfigStoreState): boolean {
  return (
    hasRuleCustomizations(state) ||
    state.deletedNodes.length > 0 ||
    state.deletedNodeNames.length > 0 ||
    Object.keys(state.listenerPorts ?? {}).length > 0 ||
    state.hiddenProxyGroups.length > 0 ||
    Object.keys(state.proxyGroupNameOverrides ?? {}).length > 0 ||
    Object.keys(state.proxyGroupAdvanced ?? {}).length > 0 ||
    state.dnsYaml.trim() !== DEFAULT_BASE_CONFIG_YAML.trim()
  );
}

export function RuleScheme({ conversionProfiles, conversionProfileId, setConversionProfileId }: Props) {
  const template = useConfigStore((state) => state.template);
  const setTemplate = useConfigStore((state) => state.setTemplate);
  const customized = useConfigStore(hasCustomizations);
  const [customize, setCustomize] = React.useState(customized);
  // An edited subscription loads after mount; open the panel once its customizations arrive.
  React.useEffect(() => {
    if (customized) setCustomize(true);
  }, [customized]);
  const [expanded, setExpanded] = React.useState<Set<SectionKey>>(() => new Set<SectionKey>(["filter"]));

  const nativeProfile = conversionProfiles.find((profile) => !profile.configUrl);
  const remoteProfiles = conversionProfiles.filter((profile) => profile.configUrl);
  const usingRemote = Boolean(nativeProfile && conversionProfileId !== nativeProfile.id);
  const currentTemplateName = TEMPLATES.find((item) => item.id === template)?.name ?? "模板";

  const toggle = (key: SectionKey) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const chooseTemplate = async (id: TemplateType) => {
    if (id === template && !usingRemote) return;
    if (id !== template && customize && hasRuleCustomizations()) {
      const ok = await confirmDialog({
        title: "切换模板？",
        description: "切换模板会重置分流代理组和自定义规则，节点管理与 DNS 设置保留。",
        confirmText: "切换",
      });
      if (!ok) return;
    }
    if (id !== template) setTemplate(id);
    if (nativeProfile) setConversionProfileId(nativeProfile.id);
  };

  return (
    <div>
      <div className="es-group-l">内置规则 · 本地生成</div>
      <div className="es-opts" role="radiogroup" aria-label="内置规则模板">
        {TEMPLATES.map((item) => {
          const on = !usingRemote && item.id === template;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`es-opt${on ? " on" : ""}`}
              onClick={() => void chooseTemplate(item.id)}
              title={item.description}
            >
              <b>{item.name}</b>
              <span className="es-mono">
                {item.groupCount} 代理组 · {item.ruleCount} 规则集
              </span>
            </button>
          );
        })}
      </div>

      {remoteProfiles.length > 0 && (
        <>
          <div className="es-group-l">ACL4SSR 在线模板 · 经转换服务生成</div>
          <div className="es-chips" role="radiogroup" aria-label="ACL4SSR 在线模板">
            {remoteProfiles.map((profile) => {
              const on = conversionProfileId === profile.id;
              return (
                <button
                  key={profile.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`es-chip${on ? " on" : ""}`}
                  onClick={() => setConversionProfileId(profile.id)}
                  title={profile.description}
                >
                  {profile.name.replace(/^ACL4SSR\s*/, "")}
                </button>
              );
            })}
          </div>
        </>
      )}

      <button
        type="button"
        className={`es-custom-toggle${customize ? " on" : ""}`}
        aria-expanded={customize}
        onClick={() => setCustomize((value) => !value)}
      >
        <span className="es-custom-ic">
          <SlidersHorizontal />
        </span>
        <span className="es-custom-tx">
          <b>自定义</b>
          <span>
            {customize
              ? `在“${usingRemote ? "ACL4SSR 模板" : currentTemplateName}”基础上调整 · 切换模板会重置分流代理组和自定义规则`
              : "筛选与改名节点、链式代理、分流代理组、规则、DNS（原高级模式）"}
          </span>
        </span>
        <span className={`es-switch${customize ? " on" : ""}`} aria-hidden="true" />
        <ChevronDown className="es-custom-chev" />
      </button>

      {customize && (
        <div className="es-custom-body">
          <NodeManagementSection isExpanded={expanded.has("filter")} onToggle={() => toggle("filter")} />
          <DialerProxyGroupsSection isExpanded={expanded.has("chain")} onToggle={() => toggle("chain")} />
          <div className={usingRemote ? "es-custom-disabled" : undefined} aria-disabled={usingRemote}>
            <ProxyGroupsSection isExpanded={!usingRemote && expanded.has("proxy")} onToggle={() => toggle("proxy")} />
            <RulesManagementSection isExpanded={!usingRemote && expanded.has("rules")} onToggle={() => toggle("rules")} />
          </div>
          <DnsSection isExpanded={expanded.has("dns")} onToggle={() => toggle("dns")} />
        </div>
      )}
      {customize && usingRemote && (
        <p className="es-note-line">
          <AlertTriangle />
          已选择 ACL4SSR 模板：分流代理组和规则由远程模板决定，这两项自定义暂时停用。
        </p>
      )}
    </div>
  );
}
