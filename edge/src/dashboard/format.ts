import { getClashConversionProfile, type ClashConversionProfileId } from "@subboost/core/subscription/clash-conversion-profiles";
import { formatIntervalLabel } from "@subboost/ui/dashboard/dashboard-format";
import type { EdgeSubscription, SubscriptionUsage } from "./types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Matches the subscription cron in wrangler.jsonc ("0 */6 * * *", UTC).
const CRON_PERIOD_HOURS = 6;

const TEMPLATE_NAMES: Record<string, string> = { minimal: "精简版", standard: "标准版", full: "完整版" };

function magnitude(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))} 分钟`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} 小时`;
  return `${Math.round(ms / DAY)} 天`;
}

// "5 小时前" / "约 19 小时后"; null when the timestamp is missing or invalid.
export function formatRelative(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const diff = at - now;
  if (Math.abs(diff) < MINUTE) return "刚刚";
  return diff < 0 ? `${magnitude(-diff)}前` : `约 ${magnitude(diff)}后`;
}

export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb >= 100 ? Math.round(gb) : Number(gb.toFixed(1))} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb >= 100 ? Math.round(mb) : Number(mb.toFixed(1))} MB`;
}

export function formatUsage(usage: SubscriptionUsage | null | undefined): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.usedBytes !== null && usage.totalBytes) {
    parts.push(`${formatBytes(usage.usedBytes)} / ${formatBytes(usage.totalBytes)}`);
  } else if (usage.usedBytes !== null) {
    parts.push(`已用 ${formatBytes(usage.usedBytes)}`);
  }
  if (usage.expireAt) {
    const date = new Date(usage.expireAt);
    if (Number.isFinite(date.getTime())) {
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      const sameYear = date.getFullYear() === new Date().getFullYear();
      parts.push(`${sameYear ? "" : `${date.getFullYear()}-`}${month}-${day} 到期`);
    }
  }
  return parts.length ? parts.join(" · ") : null;
}

export function ruleSchemeLabel(subscription: EdgeSubscription): { label: string; remote: boolean } {
  const profileId = subscription.conversionProfileId as ClashConversionProfileId | undefined;
  if (profileId && profileId !== "native") {
    const name = getClashConversionProfile(profileId)?.name ?? "ACL4SSR";
    return { label: name.replace(/^ACL4SSR\s*/, "ACL4SSR · "), remote: true };
  }
  const template = subscription.template ? TEMPLATE_NAMES[subscription.template] : undefined;
  return { label: template ? `内置规则 · ${template}` : "内置规则", remote: false };
}

export function intervalLabel(seconds: number | null): string {
  return seconds ? `每 ${formatIntervalLabel(seconds)}` : "手动更新";
}

// Next run of the 6-hourly subscription cron, shown in the viewer's local time.
export function nextCronRun(now = new Date()): Date {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours((Math.floor(now.getUTCHours() / CRON_PERIOD_HOURS) + 1) * CRON_PERIOD_HOURS);
  return next;
}

export function formatDayTime(date: Date, now = new Date()): string {
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayOffset = Math.floor((date.getTime() - startOfToday) / DAY);
  const day = dayOffset === 0 ? "今天" : dayOffset === 1 ? "明天" : `${date.getMonth() + 1}-${date.getDate()}`;
  return `${day} ${time}`;
}
