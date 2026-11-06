import { create } from "zustand";
import { api } from "./api";

/**
 * Terminal tools (lazygit, an editor…) this board has open, per task. Each is a tmux session
 * on the task's host that lasts as long as a board keeps it open: while the app is open we
 * renew it every so often, and the host ends sessions nobody renews or is attached to. The
 * list is kept for the browser tab (sessionStorage), so reloading doesn't close them.
 */

const KEY = "ia.openTools";
const KEEPALIVE_MS = 30_000;

export interface OpenTool {
  hostId: string;
  taskId: string;
  toolId: string;
}

interface ToolsState {
  open: OpenTool[];
  openTool: (t: OpenTool) => void;
  closeTool: (t: OpenTool) => void;
}

const same = (a: OpenTool, b: OpenTool) => a.hostId === b.hostId && a.taskId === b.taskId && a.toolId === b.toolId;

function load(): OpenTool[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function save(open: OpenTool[]) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(open));
  } catch {
    /* ignore */
  }
}

export const useOpenTools = create<ToolsState>((set, get) => ({
  open: load(),
  openTool: (t) => {
    if (get().open.some((o) => same(o, t))) return;
    const open = [...get().open, t];
    set({ open });
    save(open);
  },
  closeTool: (t) => {
    const open = get().open.filter((o) => !same(o, t));
    set({ open });
    save(open);
  },
}));

let timer: ReturnType<typeof setInterval> | undefined;

/** Keep every open tool's session alive while the app is open. */
export function startToolKeepalive() {
  if (timer) return;
  const tick = () => {
    for (const t of useOpenTools.getState().open) api.keepTerminal(t.hostId, t.taskId, t.toolId).catch(() => {});
  };
  tick();
  timer = setInterval(tick, KEEPALIVE_MS);
}
