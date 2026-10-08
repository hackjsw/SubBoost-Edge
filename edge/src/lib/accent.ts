export type AccentPresetId = "orange" | "amber" | "rose" | "violet" | "indigo" | "blue" | "cyan" | "green";
export type AccentId = AccentPresetId | "custom";

/** A resolved accent choice: a preset, or a custom base color. */
export type Accent = { id: AccentPresetId; hex: null } | { id: "custom"; hex: string };

export const ACCENT_STORAGE_KEY = "edgesub-accent";
export const ACCENT_HEX_STORAGE_KEY = "edgesub-accent-hex";
export const ACCENT_ATTRIBUTE = "data-accent";
export const ACCENT_CSS_VAR = "--es-accent";
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

/** WCAG AA for white label text on a brand-filled button — the bar every preset ramp clears. */
export const MIN_ACCENT_CONTRAST = 4.5;

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

/* ---------- OKLab, for clamping custom colors ---------- */

const LMS_FROM_LINEAR = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
];
const OKLAB_FROM_LMS = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766],
];
const LMS_FROM_OKLAB = [
  [1, 0.3963377774, 0.2158037573],
  [1, -0.1055613458, -0.0638541728],
  [1, -0.0894841775, -1.291485548],
];
const LINEAR_FROM_LMS = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701],
];

const apply = (m: number[][], v: number[]) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  const v = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(255, Math.max(0, v * 255)));
}

function hexToOklab(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const linear = [srgbToLinear((n >> 16) & 0xff), srgbToLinear((n >> 8) & 0xff), srgbToLinear(n & 0xff)];
  const lms = apply(LMS_FROM_LINEAR, linear).map((v) => Math.cbrt(v));
  const [l, a, b] = apply(OKLAB_FROM_LMS, lms);
  return [l, a, b];
}

function oklabToHex(lab: [number, number, number]): string {
  const lms = apply(LMS_FROM_OKLAB, lab).map((v) => v ** 3);
  const [r, g, b] = apply(LINEAR_FROM_LMS, lms).map(linearToSrgb);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

export function relativeLuminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [srgbToLinear((n >> 16) & 0xff), srgbToLinear((n >> 8) & 0xff), srgbToLinear(n & 0xff)];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Brightness budget a custom accent gets, so it meets the same contrast bar as the presets.
 * Derived from MIN_ACCENT_CONTRAST against white (1.05 / ratio - 0.05). The cap is on relative
 * luminance, not OKLab lightness: at equal lightness a yellow carries far more luminance than
 * an orange, so an L-based cap would still let yellows wash out.
 */
export const MAX_ACCENT_LUMINANCE = 1.05 / MIN_ACCENT_CONTRAST - 0.05;

/**
 * Darkens a too-bright custom color along its own hue until it is no more luminous than the
 * default accent. Scaling OKLab in place keeps the hue; luminance is not a closed form of that
 * scale, so bisect for the largest scale that still fits under the cap.
 */
export function normalizeCustomHex(hex: string): string {
  const parsed = parseHex(hex);
  if (!parsed) return hex;
  if (relativeLuminance(parsed) <= MAX_ACCENT_LUMINANCE) return parsed;

  const lab = hexToOklab(parsed);
  const at = (scale: number) => oklabToHex([lab[0] * scale, lab[1] * scale, lab[2] * scale]);
  let low = 0;
  let high = 1;
  for (let i = 0; i < 20; i += 1) {
    const mid = (low + high) / 2;
    if (relativeLuminance(at(mid)) > MAX_ACCENT_LUMINANCE) high = mid;
    else low = mid;
  }
  return at(low);
}

/* ---------- storage and DOM ---------- */

export const DEFAULT_ACCENT: Accent = { id: DEFAULT_ACCENT_ID, hex: null };

export function readAccent(): Accent {
  try {
    const id = parseAccentId(window.localStorage.getItem(ACCENT_STORAGE_KEY));
    if (id === "custom") {
      const hex = parseHex(window.localStorage.getItem(ACCENT_HEX_STORAGE_KEY));
      return hex ? { id: "custom", hex } : DEFAULT_ACCENT;
    }
    return id ? { id, hex: null } : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

export function storeAccent(accent: Accent): void {
  try {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, accent.id);
    if (accent.id === "custom") window.localStorage.setItem(ACCENT_HEX_STORAGE_KEY, accent.hex);
    else window.localStorage.removeItem(ACCENT_HEX_STORAGE_KEY);
  } catch {
    // Private mode: the choice still applies for this page view.
  }
}

export function applyAccent(accent: Accent): void {
  const root = document.documentElement;
  root.setAttribute(ACCENT_ATTRIBUTE, accent.id);
  if (accent.id === "custom") root.style.setProperty(ACCENT_CSS_VAR, accent.hex);
  else root.style.removeProperty(ACCENT_CSS_VAR);
}

/**
 * Runs inline in <head> before first paint so the page never flashes the default accent.
 * Mirrors readAccent + applyAccent; the CSS ramps do all the color math, so there is no
 * duplicated derivation here. accent.test.ts keeps both paths in sync.
 */
export const ACCENT_BOOT_SCRIPT = `(function(){var r=document.documentElement;var i=${JSON.stringify(DEFAULT_ACCENT_ID)};try{var s=localStorage.getItem(${JSON.stringify(ACCENT_STORAGE_KEY)});if(s==="custom"){var h=localStorage.getItem(${JSON.stringify(ACCENT_HEX_STORAGE_KEY)});if(h&&new RegExp(${JSON.stringify(HEX_PATTERN_SOURCE)},"i").test(h)){r.setAttribute(${JSON.stringify(ACCENT_ATTRIBUTE)},"custom");r.style.setProperty(${JSON.stringify(ACCENT_CSS_VAR)},h.toLowerCase());return}}else if(${JSON.stringify(PRESET_IDS)}.indexOf(s)>=0){i=s}}catch(e){}r.setAttribute(${JSON.stringify(ACCENT_ATTRIBUTE)},i)})();`;
