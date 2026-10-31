import { useSyncExternalStore } from "react";

/**
 * The board's appearance: dark, light, or whichever the system is set to. The choice is kept in this
 * browser (ia.theme); index.html applies it before the page paints, from the same key, so a light
 * board doesn't flash dark as it loads. The colours themselves are in index.css, under
 * html[data-theme="light"] and :root (dark).
 */
export type Theme = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEMES: { id: Theme; label: string; description: string }[] = [
  { id: "system", label: "System", description: "Follows the light or dark setting of this device" },
  { id: "light", label: "Light", description: "Always light" },
  { id: "dark", label: "Dark", description: "Always dark" },
];

export const THEME_KEY = "ia.theme";
const LIGHT_QUERY = "(prefers-color-scheme: light)";

export const isTheme = (v: unknown): v is Theme => v === "system" || v === "light" || v === "dark";

export function loadTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return isTheme(t) ? t : "system";
  } catch {
    return "system";
  }
}

/** What `theme` comes to on this device now. */
export function resolveTheme(theme: Theme, systemLight = window.matchMedia(LIGHT_QUERY).matches): ResolvedTheme {
  return theme === "system" ? (systemLight ? "light" : "dark") : theme;
}

const listeners = new Set<() => void>();
let current: Theme = loadTheme();
let resolved: ResolvedTheme = resolveTheme(current);

/** Puts the resolved theme on <html> (where index.css reads it) and in the browser's chrome colour. */
function apply() {
  resolved = resolveTheme(current);
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "light" ? "#f5f5f7" : "#131316");
  for (const l of listeners) l();
}

export function saveTheme(theme: Theme) {
  current = theme;
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* kept for this page */
  }
  apply();
}

/** Follows the system's setting, and the choice made in another tab. Call once, as the app starts. */
export function startTheme() {
  apply();
  window.matchMedia(LIGHT_QUERY).addEventListener("change", apply);
  window.addEventListener("storage", (e) => {
    if (e.key !== THEME_KEY && e.key !== null) return;
    current = loadTheme();
    apply();
  });
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

/** Calls `cb` whenever the theme shown changes. Returns the unsubscribe. */
export const onThemeChange = subscribe;

/** The theme as chosen (system, light or dark). */
export const useTheme = () => useSyncExternalStore(subscribe, () => current);

/** Light or dark, as shown now. */
export const useResolvedTheme = () => useSyncExternalStore(subscribe, () => resolved);

/** Light or dark, as shown now, outside React. */
export const resolvedTheme = () => resolved;
