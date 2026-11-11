import { Clock, Context, DateTime, Effect, FiberSet, FileSystem, Layer, Ref, Schedule, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import { Conflict, Invalid, NotFound, TaskId, Timestamp } from "@huntaway/contracts"
import type { Task, TaskServer } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound } from "../tasks/Tasks.ts"
import { commandLine, parseStat, parseTcp, shown, socketInode, taskOf } from "./devServers/proc.ts"
import type { Listening } from "./devServers/proc.ts"
import { RunDir } from "./RunDir.ts"
import { RunRepo } from "./RunRepo.ts"

// Dev servers (HA-405; huntaway's agent/servers.ts): the TCP ports the processes a task's agents started listen on,
// shown on the task (`Task.servers`) with Open and Stop.
//
// Every agent run has `HUNTAWAY_TASK_ID` in its environment, and every process it starts inherits it, unless the
// process clears its environment. Every few seconds, while any task has a live run, ended one recently or has servers
// listed, the board reads the listening sockets in `/proc/net/tcp` and `tcp6`, finds the processes whose
// `/proc/<pid>/environ` names one of those tasks, and matches their open sockets (`/proc/<pid>/fd`) to the listening
// ones. A server that outlives its run (started with `nohup` or `setsid`, or left by a run that ended) is still found,
// as its environment still names the task: it is listed as `detached`, and can be stopped all the same.
//
// Stop signals the server's process group (TERM, then KILL a few seconds later), never the agent's, its shim's or the
// board's: a server in one of those has just its own process tree signalled. Linux only: elsewhere (macOS has no
// /proc) nothing is found, and tasks list no servers.

/** How often the board looks. */
export const SCAN_EVERY = "4 seconds"
/** For how long after a task's run ends the board still looks for servers it left. */
export const AFTER_RUN_MS = 5 * 60_000
/** How long a stopped server has after TERM before KILL. */
export const STOP_GRACE = "5 seconds"
/** When the board looks again after a stop, to show it gone. */
export const RESCAN_AFTER_STOP = "500 millis"

/** Whether this host can find servers. */
export const SUPPORTED = process.platform === "linux"

export interface DevServersShape {
  /** A run of `task` ended: what it left listening is still looked for, for five minutes (`AFTER_RUN_MS`). */
  readonly notifyRunEnded: (task: TaskId) => Effect.Effect<void>
  /** Look once for the servers of the tasks the board looks at (live run, run ended lately, servers listed), and show those that changed. */
  readonly scan: Effect.Effect<void>
  /**
   * Stop the task's server on `port`: TERM to its process group (or, if that is the agent's, its shim's or the board's,
   * to its own process tree), then KILL to what is left after `STOP_GRACE`. Fails `NotFound` for a port the task does
   * not list, `Conflict` when its process no longer names the task or no longer listens there. Returns the task.
   */
  readonly stop: (task: TaskId, port: number) => Effect.Effect<Task, TaskNotFound | NotFound | Conflict | Invalid>
}

type Signal = "SIGTERM" | "SIGKILL"

/** `kill(2)`, ignoring failures. */
const signal = (target: number, sig: Signal) =>
  Effect.sync(() => {
    try {
      process.kill(target, sig)
    } catch {
      // Gone already, or not ours.
    }
  })

export class DevServers extends Context.Service<DevServers, DevServersShape>()("huntaway-server/runs/DevServers") {
  static readonly layer = Layer.effect(
    DevServers,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const sql = yield* SqlClient.SqlClient
      const db = yield* Db
      const events = yield* Events
      const tasks = yield* TaskRepo
      const runs = yield* RunRepo
      const dirs = yield* RunDir
      // When each task's last run ended, while the board still looks for what it left.
      const ended = yield* Ref.make<ReadonlyMap<TaskId, number>>(new Map())
      // Per pid, the task its environment names, read once (a process's environment as it started doesn't change).
      const envCache = yield* Ref.make<ReadonlyMap<number, string | null>>(new Map())
      // One scan at a time: a stop's rescans and the loop's would otherwise write over each other.
      const scanning = yield* Semaphore.make(1)
      // A stop's KILL and its rescans, which outlive the request.
      const later = yield* FiberSet.make()

      const readText = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => null))

      const pids = fs.readDirectory("/proc").pipe(
        Effect.map((names) => names.filter((n) => /^\d+$/.test(n)).map(Number)),
        Effect.orElseSucceed((): ReadonlyArray<number> => []),
      )

      const stat = (pid: number) => Effect.map(readText(`/proc/${pid}/stat`), (text) => (text === null ? null : parseStat(text)))

      const listening = Effect.gen(function* () {
        const all = new Map<string, Listening>()
        for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
          const text = yield* readText(file)
          if (text !== null) for (const l of parseTcp(text)) all.set(l.inode, l)
        }
        return all
      })

      /** The socket inodes a process has open. */
      const sockets = Effect.fnUntraced(function* (pid: number) {
        const dir = `/proc/${pid}/fd`
        const fds = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
        const out: Array<string> = []
        for (const fd of fds) {
          const link = yield* fs.readLink(`${dir}/${fd}`).pipe(Effect.orElseSucceed(() => ""))
          const inode = socketInode(link)
          if (inode !== null) out.push(inode)
        }
        return out
      })

      /** The processes whose environment names one of `wanted`, by task. */
      const processes = Effect.fnUntraced(function* (wanted: ReadonlySet<string>) {
        const all = yield* pids
        const live = new Set(all)
        const cache = new Map([...(yield* Ref.get(envCache))].filter(([pid]) => live.has(pid)))
        const byTask = new Map<string, Array<number>>()
        for (const pid of all) {
          let task = cache.get(pid)
          if (task === undefined) {
            // Another user's, or gone: null.
            const environ = yield* readText(`/proc/${pid}/environ`)
            task = environ === null ? null : taskOf(environ)
            cache.set(pid, task)
          }
          if (task !== null && wanted.has(task)) byTask.set(task, [...(byTask.get(task) ?? []), pid])
        }
        yield* Ref.set(envCache, cache)
        return byTask
      })

      /** The pids of the task's live runs' agents and shims, which are never stopped. */
      const runPids = Effect.fnUntraced(function* (task: TaskId) {
        const out: Array<number> = []
        for (const run of yield* runs.active) {
          if (run.task_id !== task) continue
          const p = yield* dirs.pids(run.id)
          for (const pid of [p.agent, p.shim]) if (pid !== null && pid > 1) out.push(pid)
        }
        return out
      })

      /** Whether `pid` descends from `ancestor`. */
      const descends = Effect.fnUntraced(function* (pid: number, ancestor: number) {
        for (let p = pid, i = 0; p > 1 && i < 64; i++) {
          if (p === ancestor) return true
          const s = yield* stat(p)
          if (s === null) return false
          p = s.ppid
        }
        return false
      })

      /** `pid` and its descendants. */
      const tree = Effect.fnUntraced(function* (pid: number) {
        const parent = new Map<number, number>()
        for (const p of yield* pids) parent.set(p, (yield* stat(p))?.ppid ?? 0)
        const out = [pid]
        for (let i = 0; i < out.length; i++) for (const [p, pp] of parent) if (pp === out[i] && !out.includes(p)) out.push(p)
        return out
      })

      /** The tasks to look for servers of: those with a live run, one that ended lately, or servers listed. */
      const wanted = Effect.gen(function* () {
        const ids = new Set<TaskId>((yield* runs.active).map((r) => r.task_id))
        const cutoff = (yield* Clock.currentTimeMillis) - AFTER_RUN_MS
        const recent = new Map([...(yield* Ref.get(ended))].filter(([, at]) => at >= cutoff))
        yield* Ref.set(ended, recent)
        for (const id of recent.keys()) ids.add(id)
        const listed = yield* sql<{ readonly id: string }>`SELECT id FROM tasks WHERE servers IS NOT NULL AND servers != '[]'`.pipe(Effect.orDie)
        for (const r of listed) ids.add(TaskId.make(r.id))
        return ids
      })

      /** Show `found` on the task, if what it lists changed. */
      const show = (task: TaskId, found: ReadonlyArray<TaskServer>) =>
        db.tx(
          Effect.gen(function* () {
            const before = yield* tasks.get(task)
            if (before === null) return
            const list = shown(before.servers, found)
            if (list === null) return
            yield* tasks.write(task, { servers: list }, Timestamp.make(DateTime.formatIso(yield* DateTime.now)))
            const after = yield* tasks.get(task)
            if (after !== null) yield* events.emit({ type: "task", task: after })
          }),
        )

      const scanOnce = Effect.gen(function* () {
        const ids = yield* wanted
        if (ids.size === 0) return
        const now = yield* listening
        const byTask = now.size > 0 ? yield* processes(ids) : new Map<string, Array<number>>()
        const since = Timestamp.make(DateTime.formatIso(yield* DateTime.now))
        for (const task of ids) {
          const found: Array<TaskServer> = []
          const own = yield* runPids(task)
          const agent = own[0] ?? null
          for (const pid of byTask.get(task) ?? []) {
            if (own.includes(pid) || pid === process.pid) continue
            for (const inode of yield* sockets(pid)) {
              const l = now.get(inode)
              if (l === undefined || found.some((f) => f.port === l.port && f.pid === pid)) continue
              found.push({
                port: l.port,
                address: l.address,
                pid,
                pgid: (yield* stat(pid))?.pgid ?? pid,
                command: commandLine((yield* readText(`/proc/${pid}/cmdline`)) ?? ""),
                since,
                detached: agent === null || !(yield* descends(pid, agent)),
              })
            }
          }
          yield* show(task, found)
        }
      })

      const scan = SUPPORTED ? Semaphore.withPermits(scanning, 1)(scanOnce).pipe(Effect.withSpan("DevServers.scan")) : Effect.void

      const notifyRunEnded = Effect.fn("DevServers.notifyRunEnded")(function* (task: TaskId) {
        const at = yield* Clock.currentTimeMillis
        yield* Ref.update(ended, (m) => new Map([...m, [task, at]]))
      })

      /** A scan that logs its failure: it runs in the background. */
      const scanLogged = scan.pipe(Effect.catchCause((cause) => Effect.logWarning("looking for tasks' servers", cause)))

      const stop = Effect.fn("DevServers.stop")(function* (task: TaskId, port: number) {
        if (!Number.isInteger(port) || port <= 0 || port > 65535) return yield* new Invalid({ field: "port", reason: "bad port" })
        const row = yield* tasks.get(task)
        if (row === null) return yield* new TaskNotFound({ id: task })
        const server = row.servers.find((s) => s.port === port)
        if (server === undefined) return yield* new NotFound({ what: "server", id: String(port) })
        // Still the task's, and still listening there: its pid may be another process's by now.
        const environ = (yield* readText(`/proc/${server.pid}/environ`)) ?? ""
        const holds = yield* sockets(server.pid)
        const now = yield* listening
        if (taskOf(environ) !== task || !holds.some((i) => now.get(i)?.port === port)) {
          yield* scan
          return yield* new Conflict({ reason: "changed_meanwhile", detail: "that server isn't running any more" })
        }
        const own = new Set([...(yield* runPids(task)), process.pid])
        const pgid = (yield* stat(server.pid))?.pgid ?? server.pid
        // The groups not to signal: the agent's (its pid leads it), its shim's, the board's own.
        const groups = new Set<number>([process.pid])
        for (const p of own) groups.add((yield* stat(p))?.pgid ?? p)
        const targets = pgid > 1 && !groups.has(pgid) && !own.has(pgid) ? [-pgid] : (yield* tree(server.pid)).filter((p) => !own.has(p))
        yield* Effect.logInfo(
          `task ${task}: stopping its server on port ${port} (pid ${server.pid}, ${(targets[0] ?? 0) < 0 ? `group ${pgid}` : `pids ${targets.join(" ")}`})`,
        )
        const send = (sig: Signal) => Effect.forEach(targets, (t) => signal(t, sig), { concurrency: 1, discard: true })
        yield* send("SIGTERM")
        yield* FiberSet.run(later, Effect.sleep(RESCAN_AFTER_STOP).pipe(Effect.andThen(scanLogged)))
        yield* FiberSet.run(later, Effect.sleep(STOP_GRACE).pipe(Effect.andThen(send("SIGKILL")), Effect.andThen(scanLogged)))
        return row
      })

      return DevServers.of({ notifyRunEnded, scan, stop })
    }).pipe(Effect.annotateLogs({ module: "servers" })),
  )

  /** Looks for servers every `SCAN_EVERY`, as long as the server runs (Linux only). */
  static readonly scanner = Layer.effectDiscard(
    Effect.gen(function* () {
      if (!SUPPORTED) return
      const servers = yield* DevServers
      const pass = servers.scan.pipe(Effect.catchCause((cause) => Effect.logWarning("looking for tasks' servers", cause)))
      yield* Effect.forkScoped(pass.pipe(Effect.repeat(Schedule.spaced(SCAN_EVERY)), Effect.annotateLogs({ module: "servers" })))
    }),
  )
}
