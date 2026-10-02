import { describe, expect, it } from "vitest";
import { formatBytes, formatRelative, formatUsage, intervalLabel, nextCronRun, ruleSchemeLabel } from "./format";
import type { EdgeSubscription } from "./types";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");

describe("dashboard formatting", () => {
  it("formats past and future timestamps relative to now", () => {
    expect(formatRelative("2026-10-01T07:00:00.000Z", NOW)).toBe("5 小时前");
    expect(formatRelative("2026-10-02T07:00:00.000Z", NOW)).toBe("约 19 小时后");
    expect(formatRelative("2026-09-29T12:00:00.000Z", NOW)).toBe("2 天前");
    expect(formatRelative("2026-10-01T11:59:40.000Z", NOW)).toBe("刚刚");
    expect(formatRelative(null, NOW)).toBeNull();
    expect(formatRelative("not a date", NOW)).toBeNull();
  });

  it("formats traffic usage and expiry", () => {
    expect(formatBytes(128 * 1024 ** 3)).toBe("128 GB");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
    expect(formatBytes(300 * 1024 ** 2)).toBe("300 MB");
    expect(formatUsage({ usedBytes: 128 * 1024 ** 3, totalBytes: 500 * 1024 ** 3, expireAt: null })).toBe("128 GB / 500 GB");
    expect(formatUsage({ usedBytes: 12 * 1024 ** 3, totalBytes: null, expireAt: null })).toBe("已用 12 GB");
    expect(formatUsage({ usedBytes: null, totalBytes: null, expireAt: "2030-12-31T00:00:00.000Z" })).toBe("2030-12-31 到期");
    expect(formatUsage(null)).toBeNull();
  });

  it("names rule schemes and update intervals", () => {
    const base = { conversionProfileId: "native", template: "standard" } as EdgeSubscription;
    expect(ruleSchemeLabel(base)).toEqual({ label: "内置规则 · 标准版", remote: false });
    expect(ruleSchemeLabel({ ...base, conversionProfileId: "acl4ssr-online-mini" })).toEqual({
      label: "ACL4SSR · 精简版",
      remote: true,
    });
    expect(intervalLabel(21600)).toBe("每 6 小时");
    expect(intervalLabel(null)).toBe("手动更新");
  });

  it("finds the next 6-hourly cron run in UTC", () => {
    expect(nextCronRun(new Date("2026-10-01T13:10:00.000Z")).toISOString()).toBe("2026-10-01T18:00:00.000Z");
    expect(nextCronRun(new Date("2026-10-01T18:00:00.000Z")).toISOString()).toBe("2026-10-02T00:00:00.000Z");
    expect(nextCronRun(new Date("2026-10-01T23:59:00.000Z")).toISOString()).toBe("2026-10-02T00:00:00.000Z");
  });
});
