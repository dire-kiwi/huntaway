import type { TaskServer } from "@huntaway/contracts"

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

/** What `/proc/<pid>/stat` says of a process: its parent and process group. */
export const parseStat = (text: string): { readonly ppid: number; readonly pgid: number } | null => {
  // The command (field 2) is in parentheses and may hold spaces.
  const f = text.slice(text.lastIndexOf(")") + 2).split(" ")
  const ppid = Number(f[1])
  const pgid = Number(f[2])
  return Number.isInteger(ppid) && Number.isInteger(pgid) ? { ppid, pgid } : null
}

/** A process's command line from `/proc/<pid>/cmdline`, its arguments joined, cut to 200 characters. */
export const commandLine = (cmdline: string): string => {
  const c = cmdline.split("\0").filter(Boolean).join(" ")
  return c.length > 200 ? `${c.slice(0, 199)}…` : c
}

/** The socket inode a `/proc/<pid>/fd/<n>` link names, if it is a socket. */
export const socketInode = (link: string): string | null => /^socket:\[(\d+)\]$/.exec(link)?.[1] ?? null

/** Whether two servers are shown alike. */
const same = (a: TaskServer, b: TaskServer | undefined) =>
  b !== undefined &&
  a.port === b.port &&
  a.address === b.address &&
  a.pid === b.pid &&
  a.pgid === b.pgid &&
  a.command === b.command &&
  a.since === b.since &&
  a.detached === b.detached

/**
 * What a task shows after a scan found `found`, given what it showed (`before`): when each was first seen kept, one per
 * port (a server listening on both IPv4 and IPv6 is one), by port. Null when nothing changed.
 */
export const shown = (before: ReadonlyArray<TaskServer>, found: ReadonlyArray<TaskServer>): ReadonlyArray<TaskServer> | null => {
  const list = found
    .map((f) => {
      const old = before.find((b) => b.port === f.port && b.pid === f.pid)
      return old === undefined ? f : { port: f.port, address: f.address, pid: f.pid, pgid: f.pgid, command: f.command, since: old.since, detached: f.detached }
    })
    .filter((f, i, all) => all.findIndex((g) => g.port === f.port) === i)
    .toSorted((a, b) => a.port - b.port)
  return list.length === before.length && list.every((s, i) => same(s, before[i])) ? null : list
}
