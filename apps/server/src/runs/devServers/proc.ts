import type { TaskServer, Timestamp } from "@huntaway/contracts"
import { serverWords, shimOf } from "../../tasks/Leftovers.ts"
import type { LeftoverProc } from "../../tasks/Leftovers.ts"

// What `/proc` says, read as text (huntaway's agent/servers.ts): the listening sockets of `/proc/net/tcp` and `tcp6`,
// the task a process's environment names, and a process's parent and group. Plain functions, tested on their own;
// `runs/DevServers` reads the files.

/** The variable naming the task in its agents' environment, which the processes they start inherit. */
export const TASK_ENV = "HUNTAWAY_TASK_ID"

/** A listening socket: its inode, address and port. */
export interface Listening {
  readonly inode: string
  readonly address: string
  readonly port: number
}

/** `s` cut into pieces of `n` characters. */
const chunks = (s: string, n: number): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (let i = 0; i + n <= s.length; i += n) out.push(s.slice(i, i + n))
  return out
}

/** `0100007F` (little-endian IPv4) or the 32 hex digits of an IPv6 address in /proc/net/tcp6, as text. */
export const address = (hex: string): string => {
  if (hex.length === 8) {
    const b = chunks(hex, 2).map((x) => parseInt(x, 16))
    return `${b[3]}.${b[2]}.${b[1]}.${b[0]}`
  }
  // Four little-endian 32-bit words.
  const words = chunks(hex.toLowerCase(), 8).map((w) => chunks(w, 2).toReversed().join(""))
  const groups = chunks(words.join(""), 4).map((g) => g.replace(/^0+(?=.)/, ""))
  const text = groups.join(":")
  if (text === "0:0:0:0:0:0:0:0") return "::"
  if (text === "0:0:0:0:0:0:0:1") return "::1"
  const v4 = /^0:0:0:0:0:ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(text)
  if (v4 !== null) {
    const hi = parseInt(v4[1] ?? "0", 16)
    const lo = parseInt(v4[2] ?? "0", 16)
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  }
  return text
}

/** The listening sockets in a `/proc/net/tcp`-style table. */
export const parseTcp = (text: string): ReadonlyArray<Listening> => {
  const out: Array<Listening> = []
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/)
    // sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode
    if (f.length < 10 || f[3] !== "0A") continue
    const [addr, port] = (f[1] ?? "").split(":")
    const inode = f[9]
    if (addr === undefined || addr === "" || port === undefined || port === "" || inode === undefined) continue
    out.push({ inode, address: address(addr), port: parseInt(port, 16) })
  }
  return out
}

/** The task a process's environment names (`TASK_ENV`), if any; null for one that names none. */
export const taskOf = (environ: string): string | null => {
  const prefix = `${TASK_ENV}=`
  for (const kv of environ.split("\0")) if (kv.startsWith(prefix)) return kv.slice(prefix.length) || null
  return null
}

/** What `/proc/<pid>/stat` says of a process: its parent, process group and session. */
export const parseStat = (text: string): { readonly ppid: number; readonly pgid: number; readonly sid: number } | null => {
  // The command (field 2) is in parentheses and may hold spaces.
  const f = text.slice(text.lastIndexOf(")") + 2).split(" ")
  const ppid = Number(f[1])
  const pgid = Number(f[2])
  const sid = Number(f[3])
  return Number.isInteger(ppid) && Number.isInteger(pgid) && Number.isInteger(sid) ? { ppid, pgid, sid } : null
}

/** A process as `shellsServe` sees it: its parent, its session, and the socket inodes it has open. */
export interface SessionProc {
  readonly pid: number
  readonly ppid: number
  readonly sid: number
  readonly sockets: ReadonlyArray<string>
}

/**
 * Whether every background shell of the agent `agent` is a server (HA-409): Claude Code starts each in a session of its
 * own, a child of the agent that leads it, and a server is one whose session has a process listening on a TCP port (one
 * of `listening`'s inodes). The agent's other children (its MCP servers) are in its own session. False with none.
 */
export const shellsServe = (procs: ReadonlyArray<SessionProc>, listening: ReadonlySet<string>, agent: number): boolean => {
  const shells = new Set(procs.filter((p) => p.ppid === agent && p.sid === p.pid).map((p) => p.pid))
  if (shells.size === 0) return false
  const serving = new Set(procs.filter((p) => shells.has(p.sid) && p.sockets.some((i) => listening.has(i))).map((p) => p.sid))
  return serving.size === shells.size
}

/** A process's command line from `/proc/<pid>/cmdline`, its arguments joined, cut to 200 characters. */
export const commandLine = (cmdline: string): string => {
  const c = cmdline.split("\0").filter(Boolean).join(" ")
  return c.length > 200 ? `${c.slice(0, 199)}…` : c
}

/** The socket inode a `/proc/<pid>/fd/<n>` link names, if it is a socket. */
export const socketInode = (link: string): string | null => /^socket:\[(\d+)\]$/.exec(link)?.[1] ?? null

/** `s` shown shared with tailcat since `forwarded` (HE-83), or not shared for none. */
export const sharedSince = (s: TaskServer, forwarded: Timestamp | undefined): TaskServer => {
  const plain = { port: s.port, address: s.address, pid: s.pid, pgid: s.pgid, command: s.command, since: s.since, detached: s.detached }
  return forwarded === undefined ? plain : { ...plain, forwarded }
}

/** Whether a server on `address` is reached as localhost (what tailcat proxies to, HE-85): on loopback, or on every address. */
export const onLocalhost = (host: string): boolean => ["127.0.0.1", "::1", "0.0.0.0", "::"].includes(host)

/** Whether two servers are shown alike. */
const same = (a: TaskServer, b: TaskServer | undefined) =>
  b !== undefined &&
  a.port === b.port &&
  a.address === b.address &&
  a.pid === b.pid &&
  a.pgid === b.pgid &&
  a.command === b.command &&
  a.since === b.since &&
  a.detached === b.detached &&
  a.forwarded === b.forwarded

/**
 * What a task shows after a scan found `found`, given what it showed (`before`): when each was first seen kept, one per
 * port (a server listening on both IPv4 and IPv6 is one; HE-85: of a port's, one reached as localhost if there is
 * one, so that it's shared as localhost and not refused for its other address), by port, and whether its port is shared with tailcat
 * (`forwarded`, which `PortForwards` writes). Null when nothing changed.
 */
export const shown = (before: ReadonlyArray<TaskServer>, found: ReadonlyArray<TaskServer>): ReadonlyArray<TaskServer> | null => {
  const list = found
    .map((f) => {
      const old = before.find((b) => b.port === f.port && b.pid === f.pid)
      const forwarded = before.find((b) => b.port === f.port)?.forwarded
      return sharedSince(
        old === undefined ? f : { port: f.port, address: f.address, pid: f.pid, pgid: f.pgid, command: f.command, since: old.since, detached: f.detached },
        forwarded,
      )
    })
    .filter((f, _, all) => f === (all.find((g) => g.port === f.port && onLocalhost(g.address)) ?? all.find((g) => g.port === f.port)))
    .toSorted((a, b) => a.port - b.port)
  return list.length === before.length && list.every((s, i) => same(s, before[i])) ? null : list
}

/**
 * Of `procs`, those a done or deleted task's agents left running (HA-409, `DevServers.stopLeft`): whose environment names
 * `task` (`taskOf`, by pid), but never the board (`self`), what it descends from or what it started; nor a board's
 * server or an ia-shim, or anything under one (a live agent and its shells, of this board or another; a test server the
 * agent started is `Leftovers`'), nor `own` (the task's live runs' agents and shims).
 */
export const leftRunning = (
  procs: ReadonlyArray<LeftoverProc>,
  taskOfPid: ReadonlyMap<number, string | null>,
  task: string,
  self: number,
  own: ReadonlySet<number>,
): ReadonlyArray<LeftoverProc> => {
  const byPid = new Map(procs.map((p) => [p.pid, p] as const))
  const mine = new Set<number>()
  for (let p = self, i = 0; p > 1 && i < 64; i++) {
    mine.add(p)
    p = byPid.get(p)?.ppid ?? 0
  }
  const guarded = new Set(procs.filter((p) => serverWords(p) !== null || shimOf(p) !== null).map((p) => p.pid))
  guarded.add(self)
  /** Whether `p` or one of its ancestors is guarded. */
  const under = (p: LeftoverProc) => {
    for (let q: LeftoverProc | undefined = p, i = 0; q !== undefined && q.pid > 1 && i < 64; q = byPid.get(q.ppid), i++) if (guarded.has(q.pid)) return true
    return false
  }
  return procs.filter((p) => taskOfPid.get(p.pid) === task && !mine.has(p.pid) && !own.has(p.pid) && !under(p))
}
