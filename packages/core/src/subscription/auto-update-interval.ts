export const MIN_AUTO_UPDATE_INTERVAL_SECONDS_DEFAULT = 12 * 60 * 60;
export const MIN_AUTO_UPDATE_INTERVAL_SECONDS_ADMIN = 60 * 60;
export const DEFAULT_AUTO_UPDATE_INTERVAL_HOURS = 24;

export type AutoUpdateIntervalPolicy = {
  defaultHours: number;
  minHours: number;
  stepHours: number;
  requireIntegerHours: boolean;
  // How the schedule is timed, shown next to the interval input.
  scheduleNote: string;
};

export type AutoUpdateIntervalPolicyOverride = Partial<AutoUpdateIntervalPolicy>;

export function getMinAutoUpdateIntervalSeconds(isAdmin: boolean): number {
  return isAdmin ? MIN_AUTO_UPDATE_INTERVAL_SECONDS_ADMIN : MIN_AUTO_UPDATE_INTERVAL_SECONDS_DEFAULT;
}

export function getMinAutoUpdateIntervalHours(isAdmin: boolean): number {
  return Math.round(getMinAutoUpdateIntervalSeconds(isAdmin) / 3600);
}

export function getMinAutoUpdateIntervalLabel(isAdmin: boolean): string {
  return `${getMinAutoUpdateIntervalHours(isAdmin)} 小时`;
}

export function formatAutoUpdateIntervalHoursLabel(hours: number): string {
  return `${Number.isInteger(hours) ? hours : Number(hours.toFixed(3))} 小时`;
}

export function resolveAutoUpdateIntervalPolicy(
  isAdmin: boolean,
  override?: AutoUpdateIntervalPolicyOverride
): AutoUpdateIntervalPolicy {
  return {
    defaultHours: override?.defaultHours ?? DEFAULT_AUTO_UPDATE_INTERVAL_HOURS,
    minHours: override?.minHours ?? getMinAutoUpdateIntervalHours(isAdmin),
    stepHours: override?.stepHours ?? 1,
    requireIntegerHours: override?.requireIntegerHours ?? true,
    scheduleNote: override?.scheduleNote ?? "按创建时间计时",
  };
}

export function getAutoUpdateIntervalPolicyMinLabel(policy: AutoUpdateIntervalPolicy): string {
  return formatAutoUpdateIntervalHoursLabel(policy.minHours);
}

export function autoUpdateIntervalSecondsToHours(seconds: number): number {
  return Math.round((seconds / 3600) * 1000) / 1000;
}

export function autoUpdateIntervalHoursToSeconds(hours: number): number {
  return Math.round(hours * 3600);
}
