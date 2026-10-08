export type AccentPresetId = "orange" | "amber" | "rose" | "violet" | "indigo" | "blue" | "cyan" | "green";
export type AccentId = AccentPresetId | "custom";

/** A resolved accent choice: a preset, or a custom base color with the label ink it needs. */
export type Accent = { id: AccentPresetId; hex: null; ink: null } | { id: "custom"; hex: string; ink: string };

export const ACCENT_STORAGE_KEY = "edgesub-accent";
export const ACCENT_HEX_STORAGE_KEY = "edgesub-accent-hex";
export const ACCENT_INK_STORAGE_KEY = "edgesub-accent-ink";
export const ACCENT_ATTRIBUTE = "data-accent";
export const ACCENT_CSS_VAR = "--es-accent";
export const ACCENT_INK_CSS_VAR = "--es-accent-ink";
export const DEFAULT_ACCENT_ID: AccentPresetId = "orange";

/** Swatch is each preset's ramp-500 — the most legible preview of the hue in both themes. */
export const ACCENT_PRESETS: ReadonlyArray<{ id: AccentPresetId; label: string; swatch: string }> = [
  { id: "orange", label: "橙", swatch: "#ea580c" },
  { id: "amber", label: "琥珀", swatch: "#d97706" },
  { id: "rose", label: "玫瑰", swatch: "#f43f5e" },
  { id: "violet", label: "紫", swatch: "#8b5cf6" },
  { id: "indigo", label: "靛蓝", swatch: "#6366f1" },
  { id: "blue", label: "蓝", swatch: "#3b82f6" },
  { id: "cyan", label: "青", swatch: "#0891b2" },
  { id: "green", label: "绿", swatch: "#059669" },
];

const PRESET_IDS: readonly string[] = ACCENT_PRESETS.map((p) => p.id);

/**
 * The two candidates for label text on an accent-filled button. The dark one has to be this
 * close to black: white clears AA up to luminance 0.1833, so the dark ink must clear AA from
 * 0.1833 downward, which caps its own luminance at 0.00185. A softer near-black such as
 * #0f1115 (luminance 0.0056) only reaches down to 0.200 and leaves a band of mid-dark accents
 * that neither ink can carry.
 */
export const ACCENT_INK_ON_DARK = "#ffffff";
export const ACCENT_INK_ON_LIGHT = "#030407";

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;
// Kept in sync with HEX_PATTERN; inlined into ACCENT_BOOT_SCRIPT, which cannot close over it.
const HEX_PATTERN_SOURCE = "^#[0-9a-f]{6}$";

export function parseAccentId(value: unknown): AccentId | null {
  if (value === "custom") return "custom";
  return typeof value === "string" && PRESET_IDS.includes(value) ? (value as AccentPresetId) : null;
}

export function parseHex(value: unknown): string | null {
  return typeof value === "string" && HEX_PATTERN.test(value) ? value.toLowerCase() : null;
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [srgbToLinear((n >> 16) & 0xff), srgbToLinear((n >> 8) & 0xff), srgbToLinear(n & 0xff)];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * Picks the label color for a button filled with `hex`, rather than forcing the accent to suit
 * one fixed label. White clears AA up to luminance 0.183 and near-black from 0.175, so the two
 * ranges overlap: every color the picker can produce gets a readable label, and the user's
 * choice is never altered to make room for one.
 */
export function accentInk(hex: string): string {
  const fill = relativeLuminance(hex);
  const onDark = contrast(fill, relativeLuminance(ACCENT_INK_ON_DARK));
  const onLight = contrast(fill, relativeLuminance(ACCENT_INK_ON_LIGHT));
  return onLight >= onDark ? ACCENT_INK_ON_LIGHT : ACCENT_INK_ON_DARK;
}

/* ---------- storage and DOM ---------- */

export const DEFAULT_ACCENT: Accent = { id: DEFAULT_ACCENT_ID, hex: null, ink: null };

export function customAccent(hex: string): Accent {
  const parsed = parseHex(hex) ?? hex;
  return { id: "custom", hex: parsed, ink: accentInk(parsed) };
}

export function readAccent(): Accent {
  try {
    const id = parseAccentId(window.localStorage.getItem(ACCENT_STORAGE_KEY));
    if (id === "custom") {
      const hex = parseHex(window.localStorage.getItem(ACCENT_HEX_STORAGE_KEY));
      // Ink is always recomputed: the hex is the only stored source of truth, so a change to
      // accentInk cannot leave a stale label color behind.
      return hex ? customAccent(hex) : DEFAULT_ACCENT;
    }
    return id ? { id, hex: null, ink: null } : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

export function storeAccent(accent: Accent): void {
  try {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, accent.id);
    if (accent.id === "custom") {
      window.localStorage.setItem(ACCENT_HEX_STORAGE_KEY, accent.hex);
      // Stored only so the boot script can apply it without repeating the luminance math.
      window.localStorage.setItem(ACCENT_INK_STORAGE_KEY, accent.ink);
    } else {
      window.localStorage.removeItem(ACCENT_HEX_STORAGE_KEY);
      window.localStorage.removeItem(ACCENT_INK_STORAGE_KEY);
    }
  } catch {
    // Private mode: the choice still applies for this page view.
  }
}

export function applyAccent(accent: Accent): void {
  const root = document.documentElement;
  root.setAttribute(ACCENT_ATTRIBUTE, accent.id);
  if (accent.id === "custom") {
    root.style.setProperty(ACCENT_CSS_VAR, accent.hex);
    root.style.setProperty(ACCENT_INK_CSS_VAR, accent.ink);
  } else {
    root.style.removeProperty(ACCENT_CSS_VAR);
    root.style.removeProperty(ACCENT_INK_CSS_VAR);
  }
}

/**
 * Runs inline in <head> before first paint so the page never flashes the default accent.
 * Mirrors readAccent + applyAccent. The CSS ramps do all the color derivation and the ink is
 * read back from storage, so no color math is duplicated here; accent.test.ts keeps the two
 * paths in sync, and the component re-applies on mount to heal a stale stored ink.
 */
export const ACCENT_BOOT_SCRIPT = `(function(){var r=document.documentElement;var i=${JSON.stringify(DEFAULT_ACCENT_ID)};try{var s=localStorage.getItem(${JSON.stringify(ACCENT_STORAGE_KEY)});if(s==="custom"){var p=new RegExp(${JSON.stringify(HEX_PATTERN_SOURCE)},"i");var h=localStorage.getItem(${JSON.stringify(ACCENT_HEX_STORAGE_KEY)});var k=localStorage.getItem(${JSON.stringify(ACCENT_INK_STORAGE_KEY)});if(h&&p.test(h)){r.setAttribute(${JSON.stringify(ACCENT_ATTRIBUTE)},"custom");r.style.setProperty(${JSON.stringify(ACCENT_CSS_VAR)},h.toLowerCase());if(k&&p.test(k))r.style.setProperty(${JSON.stringify(ACCENT_INK_CSS_VAR)},k.toLowerCase());return}}else if(${JSON.stringify(PRESET_IDS)}.indexOf(s)>=0){i=s}}catch(e){}r.setAttribute(${JSON.stringify(ACCENT_ATTRIBUTE)},i)})();`;
