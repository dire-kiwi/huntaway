// The desktop app's updater, exposed by electron/preload.cjs. Absent in a browser.

import { useEffect, useState } from "react";

export interface DesktopUpdateState {
  /** Whether this build updates itself (the packaged Arch app); `reason` says why not. */
  supported: boolean;
  reason?: string;
  /** The running app's version. */
  version: string;
  status: "idle" | "checking" | "none" | "downloading" | "ready" | "installing" | "error";
  /** The newer release, once one is found. */
  available?: { version: string; date?: string; url?: string | null };
  percent?: number;
  error?: string | null;
  checkedAt?: string;
}

interface DesktopBridge {
  update: {
    get(): Promise<DesktopUpdateState>;
    check(): Promise<DesktopUpdateState>;
    install(): Promise<DesktopUpdateState>;
    subscribe(cb: (s: DesktopUpdateState) => void): () => void;
  };
}

export const desktop: DesktopBridge | undefined = (window as { huntawayDesktop?: DesktopBridge }).huntawayDesktop;

/** The desktop app's update state, or null outside it. */
export function useDesktopUpdate(): DesktopUpdateState | null {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  useEffect(() => desktop?.update.subscribe(setState), []);
  return state;
}
