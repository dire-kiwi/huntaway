// The tmux side of terminals (huntaway's hosts/terminal.ts), as plain functions: the server's socket, the sessions'
// names, the arguments and environment every tmux command gets.
//
// The sessions live on a tmux server of this data folder's own, reached by its socket's path (`tmux -S <data
// dir>/tmux.sock`), never by a name (`-L`) and never without one: so they are never the default tmux server's, nor the
// live board's (the old server's `-L ia-<host>`), nor a test server's, and `TMUX` in the server's environment (a
// server started inside tmux) can't send a command to the tmux it runs in.

/** The socket's file in the data folder. */
export const SOCKET = "tmux.sock"

/** The longest socket path a Unix socket takes (`sun_path` is 104 bytes on macOS, 108 on Linux, with its NUL). */
export const MAX_SOCKET_PATH = 103

/** This data folder's tmux server's socket. */
export const socketPath = (dataDir: string): string => `${dataDir.endsWith("/") ? dataDir.slice(0, -1) : dataDir}/${SOCKET}`

/** Every tmux command's first arguments: this data folder's server, by its socket's path. */
export const serverArgs = (socket: string): ReadonlyArray<string> => ["-S", socket]

/** Why the socket can't be used, or null. */
export const socketProblem = (socket: string): string | null =>
  new TextEncoder().encode(socket).length > MAX_SOCKET_PATH
    ? `the data folder's path is too long for tmux's socket (${socket}): terminals need a shorter one`
    : null

/** `ia-<task>` for the task's shell, `ia-<task>~<tool>` for a tool (the old names, kept: sessions outlive the switch). */
export const sessionName = (task: string, tool: string | null): string => (tool === null ? `ia-${task}` : `ia-${task}~${tool}`)

/** `=name` matches the session exactly instead of by prefix. */
export const target = (task: string, tool: string | null): string => `=${sessionName(task, tool)}`

/** The task and tool a session of ours is for, or null for one that isn't ours. */
export const parseSession = (name: string): { readonly task: string; readonly tool: string | null } | null => {
  if (!name.startsWith("ia-")) return null
  const rest = name.slice(3)
  const at = rest.indexOf("~")
  const task = at === -1 ? rest : rest.slice(0, at)
  return task === "" ? null : { task, tool: at === -1 ? null : rest.slice(at + 1) }
}

/** `list-sessions -F "#{session_name} #{session_attached}"`: each session and how many clients are attached to it. */
export const parseSessions = (out: string): ReadonlyArray<{ readonly name: string; readonly attached: number }> =>
  out.split("\n").flatMap((line) => {
    const at = line.lastIndexOf(" ")
    if (at < 0) return []
    const attached = Number.parseInt(line.slice(at + 1), 10)
    return [{ name: line.slice(0, at), attached: Number.isNaN(attached) ? 0 : attached }]
  })

/**
 * tmux's environment over the server's (`extendEnv`): an agent's, without this server's settings and secrets (shells
 * inherit the tmux server's environment, and a `huntaway serve` typed there mustn't pick them up), without `TMUX` (it
 * works when this server itself runs inside tmux), and a terminal that does colour.
 */
export const tmuxEnv = (agentEnv: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> => ({
  ...agentEnv,
  TMUX: undefined,
  TMUX_PANE: undefined,
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  TERM_PROGRAM: "huntaway",
})

/**
 * Runs a tool in the user's login shell (so its PATH is the one their shells see). If it fails, the message stays on
 * screen until Enter instead of the session vanishing.
 */
export const TOOL_WRAPPER = `"\${SHELL:-/bin/sh}" -lc "$IA_TOOL_COMMAND"; s=$?; [ "$s" -eq 0 ] || { printf '\\n%s exited with status %d. Press Enter to close.' "$IA_TOOL_NAME" "$s"; read -r _; }`

/** A terminal's size from the socket's query: 2 to 1000, else the default. */
export const size = (value: string | undefined, otherwise: number): number => {
  const n = value !== undefined && /^\d+$/.test(value) ? Number(value) : Number.NaN
  return n >= 2 && n <= 1000 ? n : otherwise
}

/** A resize the client asked for, clamped to 1000, or null for one that makes no sense. */
export const resize = (cols: number, rows: number): { readonly cols: number; readonly rows: number } | null =>
  Number.isInteger(cols) && Number.isInteger(rows) && cols > 1 && rows > 1 && cols <= 65535 && rows <= 65535
    ? { cols: Math.min(cols, 1000), rows: Math.min(rows, 1000) }
    : null
