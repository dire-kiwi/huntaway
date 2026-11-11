import { Clock, Context, Effect, FileSystem, Layer, Ref, Schedule, Schema } from "effect"
import type { Scope } from "effect"
import { SecureRandom } from "effect/crypto"
import { Socket } from "effect/socket"
import type { Task, TaskId, TerminalStatus, TerminalTool } from "@huntaway/contracts"
import { DataDir } from "../platform/DataDir.ts"
import { Proc } from "../platform/Proc.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { LaunchFacts } from "../runs/LaunchFacts.ts"
import { Worktrees } from "../git/Worktrees.ts"
import { HostSettings } from "../settings/HostSettings.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound } from "../tasks/Tasks.ts"
import { TaskTmp } from "../tasks/TaskTmp.ts"
import { READY, relay } from "./attach.ts"
import { Pty } from "./Pty.ts"
import { parseSession, parseSessions, serverArgs, sessionName, socketPath, socketProblem, target, tmuxEnv, TOOL_WRAPPER } from "./tmux.ts"

// Terminals in the browser (docs/plan/06-server.md, Terminal; inventory 05, section 2.5; huntaway's hosts/terminal.ts):
// each task can have a tmux session in its working directory, and one per terminal tool (a TUI program configured in
// the host's settings: lazygit, an editor, a script…) run in the same directory. The sessions live on this data
// folder's own tmux server (`tmux.ts`), so they keep running when the browser disconnects or this server restarts. A
// socket attaches `tmux attach-session` in a pty (`Pty`) and relays it (`attach.ts`).
//
// Tool sessions last as long as a board has them open: the board renews a lease on each while it is open (and an
// attached socket renews it with each ping), and sessions that nobody is attached to and whose lease ran out are ended
// by the reaper. The reaper also ends the sessions of tasks that are gone (a project or profile deleted with them).

/** How long a tool session nobody is attached to outlives the board's last keepalive. */
export const TOOL_LEASE_MS = 90_000
export const REAP_EVERY = "30 seconds"
/** How long a ticket opens the terminal's socket. */
export const TICKET_MS = 60_000

/** The host can't have terminals: no tmux, or a data folder whose path is too long for tmux's socket. */
export class TerminalUnavailable extends Schema.TaggedError<TerminalUnavailable, { readonly brand: unique symbol }>()("TerminalUnavailable", {
  reason: Schema.String,
}) {}

/** No terminal tool with this id in the host's settings. */
export class ToolNotFound extends Schema.TaggedError<ToolNotFound, { readonly brand: unique symbol }>()("ToolNotFound", { id: Schema.String }) {}

/** A socket's ticket that was never given, was used already, or expired. */
export class TicketInvalid extends Schema.TaggedError<TicketInvalid, { readonly brand: unique symbol }>()("TicketInvalid", {}) {}

/** What a ticket opens: a task's shell, or one of its tools. */
interface Ticket {
  readonly task: TaskId
  readonly tool: TerminalTool | null
  readonly expires: number
}

/** The terminal's size, from the socket's query. */
export interface TerminalSize {
  readonly cols: number
  readonly rows: number
}

export interface TerminalsShape {
  /** The task's terminal (`tool`'s, else its shell's): whether there can be one, whether it runs, where it starts. */
  readonly status: (task: TaskId, tool: string | null) => Effect.Effect<TerminalStatus, TaskNotFound | ToolNotFound>
  /** A ticket for the terminal's socket (single use, for a minute). */
  readonly open: (task: TaskId, tool: string | null) => Effect.Effect<string, TaskNotFound | ToolNotFound | TerminalUnavailable>
  /**
   * The terminal's socket: `ticket`'s task and tool checked, then the request is upgraded (`upgrade`), the session made
   * if it isn't there and attached, and relayed until either ends. A failure after the upgrade closes the socket with
   * 1011 and the reason; the session's end closes it with 1000 "Session ended".
   */
  readonly serve: <E>(
    ticket: string,
    size: TerminalSize,
    upgrade: Effect.Effect<Socket.Socket, E>,
  ) => Effect.Effect<void, TicketInvalid | TaskNotFound | TerminalUnavailable | E, Scope.Scope>
  /** End the task's shell session, or a tool's (`tool` as given: a tool taken out of the settings can still be ended). */
  readonly kill: (task: TaskId, tool: string | null) => Effect.Effect<void, TaskNotFound>
  /** End all of a task's sessions: its shell and its tools (it's done, deleted, or its worktree is going). */
  readonly killAll: (task: TaskId) => Effect.Effect<void>
  /** A board still has this tool's session open. */
  readonly keepalive: (task: TaskId, tool: string) => Effect.Effect<void, TaskNotFound>
  /** End the tool sessions no board keeps (none attached, the lease run out) and the sessions of tasks that are gone. */
  readonly reap: Effect.Effect<void>
}

export class Terminals extends Context.Service<Terminals, TerminalsShape>()("huntaway-server/terminal/Terminals") {
  static readonly layer = Layer.effect(
    Terminals,
    Effect.gen(function* () {
      const proc = yield* Proc
      const pty = yield* Pty
      const tasks = yield* TaskRepo
      const settings = yield* HostSettings
      const facts = yield* LaunchFacts
      const taskTmp = yield* TaskTmp
      const dataDir = yield* DataDir
      const config = yield* ServerConfig
      const fs = yield* FileSystem.FileSystem
      const random = yield* SecureRandom.SecureRandom
      const socket = socketPath(dataDir.root)
      const env = tmuxEnv(config.agentEnv)
      /** When a board last kept each tool session, by session name. */
      const leases = yield* Ref.make<ReadonlyMap<string, number>>(new Map())
      const tickets = yield* Ref.make<ReadonlyMap<string, Ticket>>(new Map())

      const tmux = (args: ReadonlyArray<string>) => proc.run("tmux", [...serverArgs(socket), ...args], { env, timeout: "30 seconds" })
      /** Whether tmux is installed, asked once. */
      const installed = yield* Effect.cached(
        proc.run("tmux", ["-V"], { env, timeout: "10 seconds" }).pipe(
          Effect.map((o) => o.code === 0),
          Effect.orElseSucceed(() => false),
        ),
      )
      /** Why this host can't have terminals, or null. */
      const unavailable = Effect.gen(function* () {
        const problem = socketProblem(socket)
        if (problem !== null) return problem
        return (yield* installed) ? null : "tmux is not installed on this host"
      })

      const setLease = (name: string, at: number | null) =>
        Ref.update(leases, (m) => {
          const next = new Map(m)
          if (at === null) next.delete(name)
          else next.set(name, at)
          return next
        })
      const touch = (name: string) => Effect.flatMap(Clock.currentTimeMillis, (now) => setLease(name, now))

      const load = Effect.fnUntraced(function* (id: TaskId) {
        const task = yield* tasks.get(id)
        if (task === null) return yield* new TaskNotFound({ id })
        return task
      })
      const findTool = Effect.fnUntraced(function* (id: string | null) {
        if (id === null || id === "") return null
        const tool = (yield* settings.get).terminal_tools.find((t) => t.id === id)
        if (tool === undefined) return yield* new ToolNotFound({ id })
        return tool
      })

      const exists = Effect.fnUntraced(function* (task: string, tool: string | null) {
        if ((yield* unavailable) !== null) return false
        return yield* tmux(["has-session", "-t", target(task, tool)]).pipe(
          Effect.map((o) => o.code === 0),
          Effect.orElseSucceed(() => false),
        )
      })

      /** Our sessions, with how many clients are attached to each; none when the server isn't running. */
      const sessions = tmux(["list-sessions", "-F", "#{session_name} #{session_attached}"]).pipe(
        Effect.map((o) => (o.code === 0 ? parseSessions(o.stdout) : [])),
        Effect.orElseSucceed(() => []),
      )

      const killSession = (name: string) => Effect.andThen(tmux(["kill-session", "-t", `=${name}`]).pipe(Effect.ignore), setLease(name, null))

      /** The session for `tool` (else the task's shell), made if it isn't there. */
      const ensure = Effect.fnUntraced(function* (task: Task, tool: TerminalTool | null, size: TerminalSize) {
        const toolId = tool?.id ?? null
        if (yield* exists(task.id, toolId)) return yield* Effect.void
        const work = yield* facts.workEnv(task)
        yield* fs.makeDirectory(work.cwd, { recursive: true }).pipe(Effect.ignore)
        const vars: Array<string> = Object.entries(work.env).map(([k, v]) => `${k}=${v}`)
        // The temp folder the task's agents use, until it's done and the folder goes.
        const tmp = task.status === "done" ? null : yield* taskTmp.ensure(task)
        if (tmp !== null) vars.push(`TMPDIR=${tmp}`)
        if (tool !== null) vars.push(`IA_TOOL_NAME=${tool.name}`, `IA_TOOL_COMMAND=${tool.command}`)
        const name = sessionName(task.id, toolId)
        const args = ["new-session", "-d", "-s", name, "-c", work.cwd, "-x", String(size.cols), "-y", String(size.rows), ...vars.flatMap((v) => ["-e", v])]
        // More than one argument: tmux runs it directly rather than through its default shell, which may not be a POSIX one.
        if (tool !== null) {
          args.push("--", "/bin/sh", "-c", TOOL_WRAPPER)
          yield* touch(name)
        }
        const made = yield* tmux(args).pipe(Effect.mapError((e) => new TerminalUnavailable({ reason: e.reason })))
        if (made.code !== 0 && !(yield* exists(task.id, toolId)))
          return yield* new TerminalUnavailable({ reason: `tmux new-session failed: ${made.stderr.trim()}` })
        // The board already says which task this is. With the mouse on, the wheel scrolls tmux's history instead of
        // sending arrow keys, and selections reach the browser's clipboard (OSC 52); Shift+drag still selects in xterm.
        const t = `${target(task.id, toolId)}:`
        return yield* tmux(["set-option", "-t", t, "status", "off", ";", "set-option", "-t", t, "mouse", "on"]).pipe(Effect.ignore)
      })

      const status = Effect.fn("Terminals.status")(function* (id: TaskId, toolId: string | null) {
        const task = yield* load(id)
        const tool = yield* findTool(toolId)
        const reason = yield* unavailable
        if (reason !== null) return { available: false, running: false, cwd: null, reason, tool }
        const running = yield* exists(task.id, tool?.id ?? null)
        const cwd = (yield* facts.workEnv(task)).cwd
        return { available: true, running, cwd, reason: null, tool } satisfies TerminalStatus
      })

      const open = Effect.fn("Terminals.open")(function* (id: TaskId, toolId: string | null) {
        const task = yield* load(id)
        const tool = yield* findTool(toolId)
        const reason = yield* unavailable
        if (reason !== null) return yield* new TerminalUnavailable({ reason })
        const ticket = Array.from(yield* random.randomBytes(24), (b) => b.toString(16).padStart(2, "0")).join("")
        const now = yield* Clock.currentTimeMillis
        yield* Ref.update(tickets, (m) => new Map([...[...m].filter(([, t]) => t.expires > now), [ticket, { task: task.id, tool, expires: now + TICKET_MS }]]))
        return ticket
      })

      /** The ticket's task and tool, once: it's gone after. */
      const redeem = Effect.fnUntraced(function* (ticket: string) {
        const now = yield* Clock.currentTimeMillis
        const found = yield* Ref.modify(tickets, (m) => {
          const t = m.get(ticket)
          const next = new Map(m)
          next.delete(ticket)
          return [t, next] as const
        })
        if (found === undefined || found.expires <= now) return yield* new TicketInvalid()
        return found
      })

      const serve = <E>(ticket: string, size: TerminalSize, upgrade: Effect.Effect<Socket.Socket, E>) =>
        Effect.gen(function* () {
          const t = yield* redeem(ticket)
          const task = yield* load(t.task)
          const reason = yield* unavailable
          if (reason !== null) return yield* new TerminalUnavailable({ reason })
          const sock = yield* upgrade
          const reader = yield* sock.reader.pipe(Effect.orDie)
          const writer = yield* sock.writer
          const close = (code: number, why: string) => writer.write(new Socket.CloseEvent(code, Array.from(why).slice(0, 120).join(""))).pipe(Effect.ignore)
          const toolId = t.tool?.id ?? null
          const attached = Effect.gen(function* () {
            yield* ensure(task, t.tool, size)
            // Copying in tmux reaches the browser's clipboard (OSC 52). When the session ends, the client ends with it
            // rather than switch to another task's session.
            const tg = target(task.id, toolId)
            const args = [
              ...serverArgs(socket),
              "set-option",
              "-q",
              "-s",
              "set-clipboard",
              "external",
              ";",
              "set-option",
              "-t",
              `${tg}:`,
              "detach-on-destroy",
              "on",
              ";",
              "attach-session",
              "-t",
              tg,
            ]
            const term = yield* pty.spawn("tmux", args, { env, cols: size.cols, rows: size.rows })
            yield* writer.write(READY)
            const end = yield* relay(term, reader, writer, toolId === null ? Effect.void : touch(sessionName(task.id, toolId)))
            // The shell or tool exited (or the session was killed): the attach client has gone too.
            if (end === "ended") {
              yield* term.exited
              yield* close(1000, "Session ended")
            } else if (end === "silent") yield* close(1001, "The board stopped answering")
          })
          return yield* Effect.scoped(attached).pipe(
            // The socket went: nothing to say, and no one to say it to.
            Effect.catchTag("SocketError", () => Effect.void),
            Effect.catch((e) => Effect.andThen(Effect.logWarning(`terminal (task ${task.id}): ${e.reason}`), close(1011, e.reason))),
            Effect.catchCause((cause) => Effect.andThen(Effect.logError(`terminal (task ${task.id})`, cause), close(1011, "the terminal failed"))),
          )
        }).pipe(Effect.withSpan("Terminals.serve"), Effect.annotateLogs({ module: "terminal" }))

      const kill = Effect.fn("Terminals.kill")(function* (id: TaskId, tool: string | null) {
        yield* load(id)
        const t = tool === "" ? null : tool
        if (yield* exists(id, t)) yield* tmux(["kill-session", "-t", target(id, t)]).pipe(Effect.ignore)
        if (t !== null) yield* setLease(sessionName(id, t), null)
      })

      const killAll = Effect.fn("Terminals.killAll")(function* (id: TaskId) {
        if ((yield* unavailable) !== null) return
        for (const s of yield* sessions) if (parseSession(s.name)?.task === id) yield* killSession(s.name)
      })

      const keepalive = Effect.fn("Terminals.keepalive")(function* (id: TaskId, tool: string) {
        yield* load(id)
        yield* touch(sessionName(id, tool))
      })

      const reap = Effect.gen(function* () {
        if ((yield* unavailable) !== null) return
        const now = yield* Clock.currentTimeMillis
        const live = yield* sessions
        const names = new Set(live.map((s) => s.name))
        // Leases of sessions that went by other means are dropped.
        yield* Ref.update(leases, (m) => new Map([...m].filter(([name]) => names.has(name))))
        for (const s of live) {
          const of = parseSession(s.name)
          if (of === null) continue
          if ((yield* tasks.get(of.task)) === null) {
            yield* Effect.logInfo(`ending ${s.name}: its task is gone`)
            yield* killSession(s.name)
            continue
          }
          if (of.tool === null) continue
          const lease = (yield* Ref.get(leases)).get(s.name)
          // Sessions from before a restart get a full lease to be claimed again; one with a client attached is kept.
          if (lease === undefined || s.attached > 0) yield* setLease(s.name, now)
          else if (now - lease > TOOL_LEASE_MS) {
            yield* Effect.logInfo(`ending ${s.name}: no board has it open`)
            yield* killSession(s.name)
          }
        }
      }).pipe(Effect.withSpan("Terminals.reap"), Effect.annotateLogs({ module: "terminal" }))

      return Terminals.of({ status, open, serve, kill, killAll, keepalive, reap })
    }),
  )

  /** A worktree that is going takes its task's terminals with it (`Worktrees.beforeTeardown`). */
  static readonly registered = Layer.effectDiscard(
    Effect.gen(function* () {
      const terminals = yield* Terminals
      const worktrees = yield* Worktrees
      yield* worktrees.beforeTeardown(terminals.killAll)
    }),
  )

  /** The reaper: every `REAP_EVERY`, for as long as the server runs. */
  static readonly reaper = Layer.effectDiscard(
    Effect.gen(function* () {
      const terminals = yield* Terminals
      const tick = terminals.reap.pipe(Effect.catchCause((cause) => Effect.logWarning("ending tool terminals no board has open", cause)))
      yield* tick.pipe(Effect.repeat(Schedule.spaced(REAP_EVERY)), Effect.forkScoped)
    }),
  )
}
