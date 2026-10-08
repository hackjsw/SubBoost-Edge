export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "edgesub-theme";

// Runs inline in <head> before first paint so the page never flashes the wrong theme.
// Keep in sync with applyTheme below.
export const THEME_BOOT_SCRIPT = `(function(){var r=document.documentElement;var t="dark";try{var p=localStorage.getItem("${THEME_STORAGE_KEY}");if(p==="light"||p==="dark"){t=p}else if(window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches){t="light"}}catch(e){}r.dataset.theme=t;r.classList.remove("edgesub-light","edgesub-dark");r.classList.add("edgesub-"+t)})();`;

export function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== "system") return preference;
  // No explicit system preference falls back to the tech (dark) theme.
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.remove("edgesub-light", "edgesub-dark");
  root.classList.add(`edgesub-${theme}`);
}

export function storeThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Private mode: the choice still applies for this page view.
  }
}
