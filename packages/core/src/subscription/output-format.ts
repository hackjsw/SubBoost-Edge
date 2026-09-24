export type SubscriptionFormat = "clash" | "v2rayn";

export const V2RAYN_EXPORT_NOTICE =
  "v2rayN 仅包含可兼容的节点，不包含 Clash 分流规则、DNS、代理组或远程节点提供者；依赖链式代理或无法转换的节点会跳过。";

// Opt in explicitly; existing URLs and previously ignored query values keep
// their Clash behavior, independently of the client's User-Agent.
export function getSubscriptionFormat(url: string): SubscriptionFormat {
  return new URL(url).searchParams.get("format") === "v2rayn" ? "v2rayn" : "clash";
}

export function buildSubscriptionFormatUrl(url: string, format: SubscriptionFormat): string {
  if (format === "clash") return url;
  const result = new URL(url);
  result.searchParams.set("format", "v2rayn");
  return result.toString();
}
