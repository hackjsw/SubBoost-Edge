"use client";

import * as React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Monitor, Moon, Pipette, Sun } from "lucide-react";
import {
  applyTheme,
  readThemePreference,
  resolveTheme,
  storeThemePreference,
  type ThemePreference,
} from "@edge/lib/theme";
import {
  ACCENT_PRESETS,
  applyAccent,
  DEFAULT_ACCENT,
  normalizeCustomHex,
  readAccent,
  storeAccent,
  type Accent,
} from "@edge/lib/accent";

const THEME_OPTIONS = [
  { value: "system", label: "跟随系统", Icon: Monitor },
  { value: "light", label: "浅色", Icon: Sun },
  { value: "dark", label: "深色", Icon: Moon },
] as const satisfies ReadonlyArray<{ value: ThemePreference; label: string; Icon: typeof Monitor }>;

const PRESET_SWATCHES = new Map(ACCENT_PRESETS.map((preset) => [preset.id, preset.swatch]));

export function ThemeToggle() {
  const [preference, setPreference] = React.useState<ThemePreference>("system");
  const [accent, setAccent] = React.useState<Accent>(DEFAULT_ACCENT);
  const colorInput = React.useRef<HTMLInputElement>(null);

  // The boot script already applied both choices before paint; only mirror them into state.
  React.useEffect(() => {
    setPreference(readThemePreference());
    setAccent(readAccent());
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

  const pickTheme = (next: ThemePreference) => {
    storeThemePreference(next);
    setPreference(next);
  };

  const pickAccent = (next: Accent) => {
    storeAccent(next);
    applyAccent(next);
    setAccent(next);
  };

  const current = THEME_OPTIONS.find((option) => option.value === preference) ?? THEME_OPTIONS[0];
  const CurrentIcon = current.Icon;
  const label = `主题：${current.label}（点击设置外观）`;
  // Seeds the native picker with whatever accent is in effect, so it opens on the current color.
  const customSeed = accent.id === "custom" ? accent.hex : (PRESET_SWATCHES.get(accent.id) ?? ACCENT_PRESETS[0].swatch);

  return (
    <span className="es-theme-ctl">
      <input
        ref={colorInput}
        type="color"
        className="es-color-input"
        tabIndex={-1}
        aria-hidden="true"
        value={customSeed}
        onChange={(event) => pickAccent({ id: "custom", hex: normalizeCustomHex(event.target.value) })}
      />
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className="es-btn ghost sm icon" title={label} aria-label={label}>
          <CurrentIcon />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="es-menu" align="end" sideOffset={6}>
            {THEME_OPTIONS.map(({ value, label: optionLabel, Icon }) => (
              <DropdownMenu.Item key={value} className="es-menu-item" onSelect={() => pickTheme(value)}>
                <Icon />
                {optionLabel}
                {preference === value && <Check className="es-menu-tick" />}
              </DropdownMenu.Item>
            ))}
            <div className="es-menu-sep" />
            <div className="es-menu-label">强调色</div>
            <div className="es-swatches">
              {ACCENT_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={accent.id === preset.id ? "es-swatch on" : "es-swatch"}
                  style={{ background: preset.swatch }}
                  title={preset.label}
                  aria-label={`强调色：${preset.label}`}
                  aria-pressed={accent.id === preset.id}
                  onClick={() => pickAccent({ id: preset.id, hex: null })}
                />
              ))}
            </div>
            <DropdownMenu.Item className="es-menu-item" onSelect={() => colorInput.current?.click()}>
              <Pipette />
              自定义…
              {accent.id === "custom" && <Check className="es-menu-tick" />}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </span>
  );
}
