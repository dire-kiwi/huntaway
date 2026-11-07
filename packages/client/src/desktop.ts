import { enc, type Http } from "./http";

/** The host API with computer use (HA-273): Cua Driver on the host, the runs' `desktop` MCP server and the task viewer. */
export const DESKTOP_API = 128;

/** Installing Cua Driver on a host: how far it's got. */
export interface DesktopInstall {
  version: string;
  phase: "downloading" | "verifying" | "unpacking" | "done" | "failed";
  received: number;
  total: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/** `GET /desktop`: whether a host's agents may use its desktop, and its Cua Driver. */
export interface DesktopStatus {
  enabled: boolean;
  platform: string;
  /** The release the host would install, or null where Cua has none for it. */
  release: { version: string; bytes: number } | null;
  /** The driver it would run: installed from its page, `IA_CUA_DRIVER`, or one on PATH (whose version isn't known). */
  installed: { path: string; source: "installed" | "env" | "path"; version: string | null } | null;
  install: DesktopInstall | null;
  driver: {
    state: "stopped" | "starting" | "running" | "failed";
    version: string | null;
    error: string | null;
    started_at: string | null;
    last_call_at: string | null;
    tools: number;
    stderr: string;
  };
  /** "wayland", "x11", "macos", or null when the host has no graphical session the driver can see. */
  session: string | null;
  /** Null where the host can't tell. */
  locked: boolean | null;
  /** The task driving the desktop now. */
  in_use_by: { task_id: string; title: string } | null;
}

/** An image of what a task's agent looks at on the desktop. */
export interface DesktopFrame {
  mime: string;
  /** Base64. */
  data: string;
  width: number | null;
  height: number | null;
  /** The window's (null for the whole desktop). */
  pid: number | null;
  window_id: number | null;
  at: string;
}

/** Something a task's agent did on the desktop (its reads aren't kept). */
export interface DesktopOp {
  id: string;
  task_id: string;
  run_id: string | null;
  op_id: string | null;
  tool: "act" | "launch" | "clipboard";
  summary: string;
  status: "running" | "ok" | "failed" | "interrupted";
  result: string | null;
  created_at: string;
  finished_at: string | null;
}

export const desktopApi = ({ on }: Http) => ({
  desktopStatus: (h: string) => on(h).get<DesktopStatus>("/desktop"),
  setDesktopEnabled: (h: string, enabled: boolean) => on(h).patch<DesktopStatus>("/desktop", { enabled }),
  installDesktopDriver: (h: string) => on(h).post<DesktopStatus>("/desktop/install"),
  uninstallDesktopDriver: (h: string) => on(h).del<DesktopStatus>("/desktop/install"),
  stopDesktopDriver: (h: string) => on(h).post<DesktopStatus>("/desktop/stop"),
  /** Start the driver and ask it what it may do (`check`: its answer, or why it couldn't start). */
  checkDesktopDriver: (h: string) => on(h).post<DesktopStatus & { check: string }>("/desktop/check"),
  desktopFrame: (h: string, taskId: string) => on(h).get<{ frame: DesktopFrame | null; reason?: string }>(`/desktop/frame?task_id=${enc(taskId)}`),
  taskDesktop: (h: string, taskId: string) =>
    on(h).get<{ ops: DesktopOp[]; target: { pid: number; window_id: number | null; at: string } | null }>(`/tasks/${enc(taskId)}/desktop`),
});
