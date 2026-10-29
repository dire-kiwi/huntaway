import { useCallback, useSyncExternalStore } from "react";
import { api } from "./api";

/** Whether a preview URL answers 200: null until the first check comes back. */
export type PreviewUp = boolean | null;

const POLL_MS = 2000;

/** One poller per URL, shared by every component showing it. */
interface Poller {
  up: PreviewUp;
  listeners: Set<() => void>;
  timer: number | null;
  inflight: boolean;
}

const pollers = new Map<string, Poller>();
/** Last result per URL, so a card that remounts (e.g. moved to another column) doesn't flicker. */
const last = new Map<string, boolean>();

async function check(url: string, p: Poller) {
  p.timer = null;
  if (document.hidden) return; // resumed by the visibilitychange handler
  p.inflight = true;
  let up = false;
  try {
    up = (await api.previewStatus(url)).up;
  } catch {
    /* counts as not up */
  }
  p.inflight = false;
  if (pollers.get(url) !== p) return; // nobody is watching any more
  last.set(url, up);
  if (up !== p.up) {
    p.up = up;
    p.listeners.forEach((l) => l());
  }
  p.timer = window.setTimeout(() => check(url, p), POLL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  for (const [url, p] of pollers) if (p.timer === null && !p.inflight) check(url, p);
});

function subscribe(url: string, listener: () => void) {
  let p = pollers.get(url);
  if (!p) {
    p = { up: last.get(url) ?? null, listeners: new Set(), timer: null, inflight: false };
    pollers.set(url, p);
    check(url, p);
  }
  p.listeners.add(listener);
  return () => {
    p.listeners.delete(listener);
    if (p.listeners.size === 0) {
      if (p.timer !== null) clearTimeout(p.timer);
      pollers.delete(url);
    }
  };
}

/** Polls `url` every 2s while mounted (and the window is visible). Pass null to not poll. */
export function usePreviewUp(url: string | null | undefined): PreviewUp {
  const sub = useCallback((l: () => void) => (url ? subscribe(url, l) : () => {}), [url]);
  return useSyncExternalStore(sub, () => (url ? (pollers.get(url)?.up ?? last.get(url) ?? null) : null));
}
