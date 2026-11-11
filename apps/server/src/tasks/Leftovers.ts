import { Clock, Context, Effect, FileSystem, Layer, Path } from "effect"
import { Proc } from "../platform/Proc.ts"

// Stopping what a task's agent left running (huntaway's agent/leftovers.ts, HA-186): test servers it started with
// `scripts/test-server.sh` (or by hand), the ia-shim runs those servers started, and their agents. Test servers keep
// their data in the task's temp folder (`TaskTmp`) and run its worktree's build, so once the folder or the worktree goes
// they would run on with nothing left of them, holding memory and a port. They are stopped first.
//
// A process is a task's when it is one of this user's and:
// - a server (`… huntaway serve`, `… main.ts serve`, with a `--data-dir`) whose data dir is in the task's temp folder,
//   or whose executable, script or working directory is in the task's worktree (and whose data dir isn't another
//   task's temp folder);
// - an ia-shim whose run folder is in one of those servers' data dirs or in the temp folder, or whose executable is in
//   the worktree; or the agent under one of those shims, with its process group;
// - or started by one of those servers (a TS server's `node` under its `sh` wrapper, its MCP helpers).
//
// Never the board itself or what runs its own agents: not this process or its parents, no server on the board's data
// dir, and no shim with a run in the board's `runs` folder. Processes are found by what `/proc` says of them (their
// command line, executable and working directory), or `ps` and `lsof` where there is no `/proc` (macOS), never by a
// pattern given to `pkill`, and stopped by pid: TERM, then KILL if they are still there after `GRACE`, and still the
// same process (by when they started).

/** How long a process has to stop after TERM before it is killed. */
export const GRACE_MILLIS = 5000

export interface LeftoverProc {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly uid: number
  /** When it started, as `/proc/<pid>/stat` or `ps -o lstart` tells it: with the pid, which process this is. */
  readonly start: string
  /** Its arguments, where they are known one by one (`/proc`); null with `ps`, which only gives the command line. */
  readonly argv: ReadonlyArray<string> | null
  /** Its command line, its arguments joined with spaces. */
  readonly cmd: string
  /** Its executable (`/proc/<pid>/exe`), if it can be read. */
  readonly exe: string | null
}

/** What belongs to a task, and what must be left alone. */
export interface LeftoverScope {
  /** The task's temp folder, as the board names it and by its real path (`variants`); none to go by the worktrees alone. */
  readonly tmp: ReadonlyArray<string>
  /** The task's worktrees (one for a task; a temp folder may be shared by tasks whose ids start alike). */
  readonly worktrees: ReadonlyArray<string>
  /** The board's data dir: its server and its runs' shims are never stopped. */
  readonly data_dir: string
  /** The folder all of the board's tasks' temp folders are in: a server whose data dir is in another task's isn't this task's. */
  readonly tmp_root: string | null
}

// ---- pure ---------------------------------------------------------------------------------------------------------

/** `p` without doubled or trailing slashes. */
export const trimPath = (p: string): string => {
  let s = p.replace(/\/+/g, "/")
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1)
  return s
}

/** Whether path `p` is `base` or inside it, for any of `bases` (by whole components). */
export const within = (p: string, bases: ReadonlyArray<string>): boolean => {
  const a = trimPath(p)
  return bases.some((b) => a === b || a.startsWith(b === "/" ? "/" : `${b}/`))
}

/** Whether the joined command line `cmd` names a path in one of `bases` (a path in it may hold spaces, so it's searched). */
const names = (cmd: string, bases: ReadonlyArray<string>): boolean =>
  bases.some((b) => cmd.startsWith(`${b}/`) || cmd.includes(` ${b}/`) || cmd.includes(`=${b}/`))

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1)
const isAbsolute = (p: string): boolean => p.startsWith("/")

/** The words of `p`'s command line up to `serve`, if it's a huntaway server (`…/huntaway serve`, `…/main.ts serve`). */
export const serverWords = (p: LeftoverProc): ReadonlyArray<string> | null => {
  const words = p.argv ?? p.cmd.split(" ")
  const i = words.indexOf("serve")
  if (i < 1 || !words.slice(0, i).some((w) => /^(huntaway|issue-agent|main\.[jt]s)$/.test(baseName(w)))) return null
  if (!words.slice(i + 1).some((w) => w === "--data-dir" || w.startsWith("--data-dir="))) return null
  return words.slice(0, i)
}

/** A server's `--data-dir` as it was given (relative or not). */
const givenDataDir = (p: LeftoverProc): string | null => {
  if (p.argv !== null) {
    const i = p.argv.findIndex((w) => w === "--data-dir" || w.startsWith("--data-dir="))
    if (i < 0) return null
    const w = p.argv[i] ?? ""
    return w.startsWith("--data-dir=") ? w.slice("--data-dir=".length) : (p.argv[i + 1] ?? null)
  }
  // Up to the next option: test-server.sh puts `--name` after it.
  return / --data-dir[= ](.+?)(?= --?[A-Za-z]|$)/.exec(p.cmd)?.[1] ?? null
}

/** An ia-shim's executable and run folder (`…/ia-shim <run dir> -- <agent…>`). */
export const shimOf = (p: LeftoverProc): { readonly exe: string; readonly run: string } | null => {
  if (p.argv !== null) {
    const i = p.argv.findIndex((w) => baseName(w) === "ia-shim")
    const exe = p.argv[i]
    const run = p.argv[i + 1]
    return i >= 0 && i < 2 && exe !== undefined && run !== undefined && run !== "" ? { exe, run } : null
  }
  const m = /^(.*?\/?ia-shim) (.+?) -- /.exec(p.cmd)
  return m?.[1] !== undefined && m[2] !== undefined ? { exe: m[1], run: m[2] } : null
}

/** `pid`'s ancestors' pids, by the parents in `byPid`. */
const ancestors = (pid: number, byPid: ReadonlyMap<number, LeftoverProc>): Set<number> => {
  const out = new Set<number>()
  for (let p = byPid.get(pid); p !== undefined && !out.has(p.ppid) && p.ppid > 1; p = byPid.get(p.ppid)) out.add(p.ppid)
  return out
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The task folders (named as `TaskTmp` names them) in `roots` that servers and shims in `procs` name. */
export const foldersIn = (procs: ReadonlyArray<LeftoverProc>, roots: ReadonlyArray<string>): Set<string> => {
  const out = new Set<string>()
  for (const p of procs) {
    if (serverWords(p) === null && shimOf(p) === null) continue
    for (const r of roots) {
      for (const m of p.cmd.matchAll(new RegExp(`${escape(r)}/([0-9a-f]{12})(?=/| |$)`, "g"))) if (m[1] !== undefined) out.add(m[1])
    }
  }
  return out
}

/** `ps`'s fixed-width `lstart` (`Thu Nov  5 10:00:00 2026`) comes before the command line, which may hold anything. */
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S{3} \S{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s(.*)$/

/** The processes of user `uid` in `ps -o pid=,ppid=,pgid=,uid=,lstart=,command=`'s output. */
export const parsePs = (stdout: string, uid: number): ReadonlyArray<LeftoverProc> =>
  stdout.split("\n").flatMap((line) => {
    const m = PS_LINE.exec(line)
    if (m === null || Number(m[4]) !== uid) return []
    return [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), uid, start: m[5] ?? "", argv: null, cmd: (m[6] ?? "").trim(), exe: null }]
  })

// ---- the service ----------------------------------------------------------------------------------------------------

export interface LeftoversShape {
  /** All of this user's processes, or null (logged) if they can't be listed. */
  readonly list: Effect.Effect<ReadonlyArray<LeftoverProc> | null>
  /** Processes from `ps` (macOS, or anywhere without `/proc`); exposed to be tested on Linux. */
  readonly listPs: Effect.Effect<ReadonlyArray<LeftoverProc>>
  /** A path and, if it resolves to another, its real path: a process may name a folder either way. */
  readonly variants: (p: string) => Effect.Effect<ReadonlyArray<string>>
  /** The processes of `procs` that belong to the task `scope` describes (see the top of this file), servers first. */
  readonly find: (procs: ReadonlyArray<LeftoverProc>, scope: LeftoverScope) => Effect.Effect<ReadonlyArray<LeftoverProc>>
  /** Stop `procs` by pid: TERM, then KILL those still there after `graceMillis` that are still the same processes. */
  readonly stop: (procs: ReadonlyArray<LeftoverProc>, graceMillis?: number) => Effect.Effect<void>
  /**
   * Stop the processes that belong to the task `scope` describes, of `procs` (else all of them, listed now), and
   * return them. `what` says why, in the log.
   */
  readonly stopTask: (scope: LeftoverScope, what: string, procs?: ReadonlyArray<LeftoverProc>) => Effect.Effect<ReadonlyArray<LeftoverProc>>
}

type Signal = "SIGTERM" | "SIGKILL"

/** `kill(2)`, ignoring failures (a process that has gone). */
const signal = (pid: number, sig: Signal) =>
  Effect.sync(() => {
    try {
      process.kill(pid, sig)
    } catch {
      // Gone already, or not ours to signal.
    }
  })

export class Leftovers extends Context.Service<Leftovers, LeftoversShape>()("huntaway-server/tasks/Leftovers") {
  static readonly layer = Layer.effect(
    Leftovers,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const proc = yield* Proc
      const linux = process.platform === "linux"
      const me = process.geteuid?.() ?? -1

      /** One process from `/proc`, or null if it's gone or isn't this user's. */
      const readProc = (pid: number): Effect.Effect<LeftoverProc | null> =>
        Effect.gen(function* () {
          const d = `/proc/${pid}`
          const uid = (yield* fs.stat(d)).uid
          if (uid._tag === "None" || uid.value !== me) return null
          const stat = yield* fs.readFileString(`${d}/stat`)
          // `pid (comm) state ppid pgrp …`: comm may hold spaces and parentheses, so fields are counted from the last ')'.
          const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
          const raw = yield* fs.readFile(`${d}/cmdline`)
          // A kernel thread or a zombie.
          if (raw.length === 0) return null
          const argv = new TextDecoder().decode(raw).replace(/\0$/, "").split("\0")
          const exe = yield* fs.readLink(`${d}/exe`).pipe(
            Effect.map((e) => e.replace(/ \(deleted\)$/, "")),
            Effect.orElseSucceed(() => null),
          )
          return { pid, ppid: Number(f[1]), pgid: Number(f[2]), uid: me, start: f[19] ?? "", argv, cmd: argv.join(" "), exe }
        }).pipe(Effect.orElseSucceed(() => null))

      const listProc = Effect.gen(function* () {
        const pids = (yield* fs.readDirectory("/proc"))
          .filter((n) => /^\d+$/.test(n))
          .map(Number)
          .toSorted((x, y) => x - y)
        const read = yield* Effect.forEach(pids, readProc, { concurrency: 16 })
        return read.filter((p): p is LeftoverProc => p !== null)
      })

      const listPs = Effect.gen(function* () {
        const o = yield* proc
          .run("ps", ["-axww", "-o", "pid=,ppid=,pgid=,uid=,lstart=,command="], { env: { LC_ALL: "C" }, timeout: "20 seconds" })
          .pipe(Effect.orDie)
        if (o.code !== 0) return yield* Effect.die(new Error(`ps: ${o.stderr.trim() || `exit ${o.code}`}`))
        return parsePs(o.stdout, me)
      })

      const listing: Effect.Effect<ReadonlyArray<LeftoverProc>, unknown> = linux ? listProc : listPs
      const list: Effect.Effect<ReadonlyArray<LeftoverProc> | null> = listing.pipe(
        Effect.catchCause((cause) => Effect.as(Effect.logWarning("listing processes", cause), null)),
      )

      /** `p`'s working directory: `/proc/<pid>/cwd`, or `lsof` without `/proc`. */
      const readCwd = (p: LeftoverProc): Effect.Effect<string | null> =>
        linux
          ? fs.readLink(`/proc/${p.pid}/cwd`).pipe(Effect.orElseSucceed(() => null))
          : proc.run("lsof", ["-a", "-p", String(p.pid), "-d", "cwd", "-Fn"], { timeout: "10 seconds" }).pipe(
              Effect.map(
                (o) =>
                  o.stdout
                    .split("\n")
                    .find((l) => l.startsWith("n"))
                    ?.slice(1) ?? null,
              ),
              Effect.orElseSucceed(() => null),
            )

      const variants = (p: string) =>
        Effect.gen(function* () {
          const out = [trimPath(p)]
          const real = yield* fs.realPath(p).pipe(Effect.orElseSucceed(() => null))
          if (real !== null && !out.includes(trimPath(real))) out.push(trimPath(real))
          return out
        })
      const allVariants = (ps: ReadonlyArray<string>) => Effect.map(Effect.forEach(ps, variants, { concurrency: 1 }), (vs) => [...new Set(vs.flat())])

      const find = Effect.fn("Leftovers.find")(function* (procs: ReadonlyArray<LeftoverProc>, s: LeftoverScope) {
        const tmp = yield* allVariants(s.tmp)
        const wts = yield* allVariants(s.worktrees)
        const board = yield* variants(s.data_dir)
        const boardRuns = board.map((d) => `${d}/runs`)
        const roots = s.tmp_root === null ? [] : yield* variants(s.tmp_root)
        const byPid = new Map(procs.map((p) => [p.pid, p]))
        // Each process's working directory, read when it's needed.
        const cwds = new Map<number, string | null>()
        const cwd = (p: LeftoverProc) =>
          Effect.gen(function* () {
            const known = cwds.get(p.pid)
            if (known !== undefined) return known
            const c = yield* readCwd(p)
            cwds.set(p.pid, c)
            return c
          })
        // Never this server, or what started it.
        const keep = ancestors(process.pid, byPid)
        keep.add(process.pid)
        const candidates = procs.filter((p) => !keep.has(p.pid))

        const servers: Array<LeftoverProc> = []
        const dataDirs: Array<string> = []
        for (const p of candidates) {
          const words = serverWords(p)
          if (words === null) continue
          const given = givenDataDir(p)
          if (given === null || given === "") continue
          let d: string
          if (isAbsolute(given)) d = trimPath(given)
          else {
            const c = yield* cwd(p)
            if (c === null) continue
            d = path.resolve(c, given)
          }
          const dv = yield* variants(d)
          if (dv.some((v) => board.includes(v))) continue
          let ours = tmp.length > 0 && within(d, tmp)
          // Started from the worktree, with its data somewhere other than another task's temp folder.
          if (!ours && wts.length > 0 && !(roots.length > 0 && within(d, roots))) {
            const c = yield* cwd(p)
            const exeIn = (p.exe !== null && within(p.exe, wts)) || words.some((w) => within(c !== null && !isAbsolute(w) ? path.resolve(c, w) : w, wts))
            ours = exeIn || names(words.join(" "), wts) || (c !== null && within(c, wts))
          }
          if (ours) {
            servers.push(p)
            dataDirs.push(...dv)
          }
        }

        const shims: Array<LeftoverProc> = []
        for (const p of candidates) {
          const sh = shimOf(p)
          if (sh === null || within(sh.run, boardRuns)) continue
          const r = sh.run
          // One of the worktree's builds, running a run that isn't another task's.
          const built = wts.length > 0 && (within(sh.exe, wts) || (p.exe !== null && within(p.exe, wts))) && !(roots.length > 0 && within(r, roots))
          if (within(r, dataDirs) || (tmp.length > 0 && within(r, tmp)) || built) shims.push(p)
        }

        // What the servers started, and the shims' agents with their process groups.
        const picked = new Set([...servers, ...shims].map((p) => p.pid))
        const agents = new Set<number>()
        for (const p of candidates) if (picked.has(p.ppid) && shims.some((sh) => sh.pid === p.ppid)) agents.add(p.pgid === p.pid ? p.pgid : p.pid)
        const under: Array<LeftoverProc> = []
        for (const p of candidates) {
          if (picked.has(p.pid)) continue
          const up = ancestors(p.pid, byPid)
          const fromServer = servers.some((sv) => up.has(sv.pid))
          const fromAgent = agents.has(p.pgid) || shims.some((sh) => up.has(sh.pid))
          if (fromServer || fromAgent) under.push(p)
        }
        return [...servers, ...under, ...shims]
      })

      /** Those of `procs` that are still running as the same processes (not new ones given their pids), by when they started. */
      const running = (procs: ReadonlyArray<LeftoverProc>) =>
        Effect.gen(function* () {
          if (linux) {
            // A zombie's cmdline is empty, so it reads as gone.
            const now = yield* Effect.forEach(procs, (p) => readProc(p.pid), { concurrency: 16 })
            return procs.filter((p, i) => now[i]?.start === p.start)
          }
          const now = new Map((yield* listPs.pipe(Effect.orElseSucceed((): ReadonlyArray<LeftoverProc> => []))).map((q) => [q.pid, q.start] as const))
          return procs.filter((p) => now.get(p.pid) === p.start)
        })

      const stop = Effect.fn("Leftovers.stop")(function* (procs: ReadonlyArray<LeftoverProc>, graceMillis: number = GRACE_MILLIS) {
        yield* Effect.forEach(procs, (p) => signal(p.pid, "SIGTERM"), { concurrency: 1, discard: true })
        const since = yield* Clock.currentTimeMillis
        let left = procs
        while (true) {
          left = yield* running(left)
          if (left.length === 0) return
          if ((yield* Clock.currentTimeMillis) - since >= graceMillis) break
          yield* Effect.sleep("100 millis")
        }
        yield* Effect.forEach(left, (p) => signal(p.pid, "SIGKILL"), { concurrency: 1, discard: true })
      })

      const stopTask = Effect.fn("Leftovers.stopTask")(function* (scope: LeftoverScope, what: string, procs?: ReadonlyArray<LeftoverProc>) {
        const all = procs ?? (yield* list)
        if (all === null) return []
        const found = yield* find(all, scope)
        if (found.length === 0) return []
        for (const p of found) yield* Effect.logInfo(`${what}: stopping pid ${p.pid}, left running by the task: ${p.cmd.slice(0, 300)}`)
        yield* stop(found)
        return found
      })

      return Leftovers.of({ list, listPs, variants, find, stop, stopTask })
    }),
  )
}
