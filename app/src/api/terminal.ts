import { enc, on, wsUrl } from "./http";

/** A program run in its own tmux session in a task's directory, e.g. `lazygit` (API 13). */
export interface TerminalTool {
  id: string;
  name: string;
  command: string;
}

/** A task's tmux terminal on its host (API 7). */
export interface TerminalStatus {
  /** False when the host has no tmux. */
  available: boolean;
  /** Whether the session exists (it outlives the browser and the server). */
  running: boolean;
  cwd?: string | null;
  reason?: string;
  /** The tool this session runs, when asked for one (API 13). */
  tool?: TerminalTool | null;
}

const toolQuery = (tool?: string) => (tool ? `?tool=${encodeURIComponent(tool)}` : "");

/** Websocket attached to a task's terminal (or one of its tools); the session is created if needed. */
export const terminalWsUrl = (h: string, id: string, cols: number, rows: number, tool?: string) =>
  wsUrl(`/h/${enc(h)}/tasks/${enc(id)}/terminal/ws?cols=${cols}&rows=${rows}${tool ? `&tool=${encodeURIComponent(tool)}` : ""}`);

export const terminalApi = {
  /** The task's shell, or with `tool` one of the host's terminal tools (API 13). */
  terminal: (h: string, id: string, tool?: string) => on(h).get<TerminalStatus>(`/tasks/${enc(id)}/terminal${toolQuery(tool)}`),
  killTerminal: (h: string, id: string, tool?: string) => on(h).del(`/tasks/${enc(id)}/terminal${toolQuery(tool)}`),
  /** Tool sessions end once no board renews them (and nobody is attached). */
  keepTerminal: (h: string, id: string, tool: string) => on(h).post(`/tasks/${enc(id)}/terminal/keepalive${toolQuery(tool)}`),
};
