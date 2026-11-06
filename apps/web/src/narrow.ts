import { useSyncExternalStore } from "react";
import { create } from "zustand";

/**
 * The narrow layout, for phones: below this width the sidebar is a drawer, a board shows one column at a time and a
 * task opens over the whole screen. The same width as the `narrow:` variant in index.css. Wider windows (and the
 * desktop app, whose window is at least 900 wide) keep the desktop layout.
 */
export const NARROW_QUERY = "(max-width: 699.98px)";

/** A touch screen as the main pointer, where dragging cards doesn't work: they get a menu button to move them instead. */
export const TOUCH_QUERY = "(pointer: coarse)";

function useMedia(query: string) {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
  );
}

export const useNarrow = () => useMedia(NARROW_QUERY);
export const useTouch = () => useMedia(TOUCH_QUERY);

/** Whether the narrow layout's sidebar drawer is open. */
export const useDrawer = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** iOS and iPadOS, which zoom in on a field whose text is smaller than 16px when it's focused. */
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/**
 * Fits the page to a phone's screen. On iOS, focusing a field doesn't zoom in (pinching still does: iOS leaves the
 * maximum scale to the user). `--app-height` follows the part of the window that isn't behind the on-screen keyboard,
 * so the composer stays above it: Android resizes the page for the keyboard itself (`interactive-widget` in
 * index.html), but iOS only shrinks the visual viewport and scrolls the page up to the field, taking the header off
 * the top.
 */
export function setUpViewport() {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (IOS && meta && !meta.content.includes("maximum-scale")) meta.content += ", maximum-scale=1";
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const update = () => {
    // Only while something is covering the bottom of the window: zooming in shrinks the visual viewport too.
    const covered = vv.scale <= 1.01 && window.innerHeight - vv.height > 80;
    if (covered) {
      root.style.setProperty("--app-height", `${Math.round(vv.height)}px`);
      if (window.scrollY) window.scrollTo(0, 0);
    } else root.style.removeProperty("--app-height");
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  update();
}
