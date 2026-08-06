const ACL4SSR_CONFIG_BASE_URL =
  "https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config";

export const CLASH_CONVERSION_PROFILES = [
  {
    id: "native",
    name: "EdgeSub 原生",
    description: "保留当前编辑器生成的代理组、DNS 与规则",
    provider: "EdgeSub",
    tags: ["原生", "即时"],
    configUrl: null,
    recommended: true,
  },
  {
    id: "acl4ssr-online",
    name: "ACL4SSR 标准版",
    description: "常用分流、广告拦截与自动测速的均衡方案",
    provider: "ACL4SSR",
    tags: ["均衡", "自动测速"],
    configUrl: `${ACL4SSR_CONFIG_BASE_URL}/ACL4SSR_Online.ini`,
    recommended: true,
  },
  {
    id: "acl4ssr-online-mini",
    name: "ACL4SSR 精简版",
    description: "减少代理组与规则数量，适合轻量客户端",
    provider: "ACL4SSR",
    tags: ["精简", "低占用"],
    configUrl: `${ACL4SSR_CONFIG_BASE_URL}/ACL4SSR_Online_Mini.ini`,
    recommended: false,
  },
  {
    id: "acl4ssr-online-full",
    name: "ACL4SSR 完整版",
    description: "覆盖更多服务与流媒体规则，代理组更细致",
    provider: "ACL4SSR",
    tags: ["完整", "扩展规则"],
    configUrl: `${ACL4SSR_CONFIG_BASE_URL}/ACL4SSR_Online_Full.ini`,
    recommended: false,
  },
  {
    id: "acl4ssr-online-mini-ai",
    name: "ACL4SSR AI 版",
    description: "在精简方案上增加常用 AI 服务分流",
    provider: "ACL4SSR",
    tags: ["AI", "精简"],
    configUrl: `${ACL4SSR_CONFIG_BASE_URL}/ACL4SSR_Online_Mini_Ai.ini`,
    recommended: false,
  },
  {
    id: "acl4ssr-online-multi-country",
    name: "ACL4SSR 多地区版",
    description: "按香港、台湾、日本、新加坡和美国等地区分组",
    provider: "ACL4SSR",
    tags: ["多地区", "细分"],
    configUrl: `${ACL4SSR_CONFIG_BASE_URL}/ACL4SSR_Online_MultiCountry.ini`,
    recommended: false,
  },
  {
    id: "acl4ssr-online-no-auto",
    name: "ACL4SSR 无测速版",
    description: "移除自动测速组，减少后台探测请求",
    provider: "ACL4SSR",
    tags: ["无测速", "手动选择"],
    configUrl: `${ACL4SSR_CONFIG_BASE_URL}/ACL4SSR_Online_NoAuto.ini`,
    recommended: false,
  },
  {
    id: "acl4ssr-online-no-reject",
    name: "ACL4SSR 无拦截版",
    description: "保留常用分流，不启用广告拒绝策略",
    provider: "ACL4SSR",
    tags: ["无拦截", "兼容"],
    configUrl: `${ACL4SSR_CONFIG_BASE_URL}/ACL4SSR_Online_NoReject.ini`,
    recommended: false,
  },
] as const;

export type ClashConversionProfile = (typeof CLASH_CONVERSION_PROFILES)[number];
export type ClashConversionProfileId = ClashConversionProfile["id"];

export const DEFAULT_CLASH_CONVERSION_PROFILE_ID: ClashConversionProfileId = "native";
export const DEFAULT_ACL4SSR_PROFILE_ID: ClashConversionProfileId = "acl4ssr-online";

export function isClashConversionProfileId(value: unknown): value is ClashConversionProfileId {
  return (
    typeof value === "string" &&
    CLASH_CONVERSION_PROFILES.some((profile) => profile.id === value)
  );
}

export function getClashConversionProfile(
  id: ClashConversionProfileId
): ClashConversionProfile {
  return CLASH_CONVERSION_PROFILES.find((profile) => profile.id === id)!;
}

export function resolveClashConversionProfileId(
  value: unknown,
  fallback: ClashConversionProfileId = DEFAULT_CLASH_CONVERSION_PROFILE_ID
): ClashConversionProfileId {
  return isClashConversionProfileId(value) ? value : fallback;
}
