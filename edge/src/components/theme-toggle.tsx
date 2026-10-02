"use client";

import * as React from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  applyTheme,
  nextThemePreference,
  readThemePreference,
  resolveTheme,
  storeThemePreference,
  type ThemePreference,
} from "@edge/lib/theme";

const LABELS: Record<ThemePreference, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

export function ThemeToggle() {
  const [preference, setPreference] = React.useState<ThemePreference>("system");

  React.useEffect(() => {
    setPreference(readThemePreference());
  }, []);

  React.useEffect(() => {
    applyTheme(resolveTheme(preference));
    if (preference !== "system") return;
    const media = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!media) return;
    const onChange = () => applyTheme(resolveTheme("system"));
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  const cycle = () => {
    const next = nextThemePreference(preference);
    storeThemePreference(next);
    setPreference(next);
  };

  const Icon = preference === "light" ? Sun : preference === "dark" ? Moon : Monitor;
  const label = `主题：${LABELS[preference]}（点击切换）`;
  return (
    <button type="button" className="es-btn ghost sm icon" onClick={cycle} title={label} aria-label={label}>
      <Icon />
    </button>
  );
}
