import {
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Ref,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  SubscriptionRef,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { ChildProcessSpawner } from "effect/process"
import type { Socket } from "effect/socket"
import type { BrowserPage, BrowserRole, TaskId } from "@huntaway/contracts"
import { toJson } from "../platform/columns.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { Tasks } from "../tasks/Tasks.ts"
import type { TaskNotFound } from "../tasks/Tasks.ts"
import { isRecord, makeCdp, pageOf, str } from "./cdp.ts"
import type { Cdp, CdpError, CdpPage, CdpResult } from "./cdp.ts"
import { startChrome } from "./chrome.ts"
import type { ChromeProcess } from "./chrome.ts"
import { ChromeInstall, ChromeUnavailable } from "./ChromeInstall.ts"
import type { ChromeInstalling } from "./ChromeInstall.ts"
import { history, navigate, pageInfo, preparePage } from "./page.ts"
import type { PageRefused } from "./page.ts"
import { relayViewer, socketText } from "./viewer.ts"

// Each task's web browser (HE-62; docs/plan/06-server.md, Browser): one page per task, which its agent drives (the
// `browser` MCP server, `BrowserTools`) and the board shows beside the thread. The page is in one of two places:
//
// - **The desktop app's pane**, while the app shows the task on this host: its <webview>, driven through the app's
//   relay of its debugger (`attachDesktop`). It is the user's own browser, so it is the one the agent uses then.
// - **Otherwise a headless Chrome on this host** (`ChromeInstall`, one process for every task, one page each), which
//   the board's viewers watch and use as a stream (`view`).
//
// The page's address carries over when it moves: a desktop pane that attaches loads the address the headless page
// was on (and that page closes); once the pane goes, the next use opens a headless page at the pane's last address.
// Cookies and storage don't carry over (the pane has the app's own session, the headless browser its profile in the
// data folder). A headless page nobody has used or watched for `IDLE` closes; Chrome exits once it has no pages.

/** A socket's ticket that was never given, was used already, or expired. */
export class BrowserTicketInvalid extends Schema.TaggedError<BrowserTicketInvalid, { readonly brand: unique symbol }>()("BrowserTicketInvalid", {}) {}

/** Where a task's page is. */
export type BrowserBackend = "headless" | "desktop"

/** A task's page, to drive. */
export interface TaskPage {
  readonly page: CdpPage
  readonly backend: BrowserBackend
}

/** What the agent is told of the task's browser. */
export interface BrowserState extends BrowserPage {
  readonly backend: BrowserBackend
  /** Viewers watching the stream now (the desktop pane counts as one). */
  readonly watching: number
  /** The last dialog (alert, confirm, prompt) the headless page showed, which was accepted for it. */
  readonly dialog: string | null
}

export interface BrowsersShape {
  /** The task's page, opened headless (at its last address, else `url`) if it has none. */
  readonly page: (task: TaskId, url?: string) => Effect.Effect<TaskPage, ChromeUnavailable | CdpError | TaskNotFound>
  /** The task's browser now, if it has one open. */
  readonly state: (task: TaskId) => Effect.Effect<BrowserState | null>
  /** Close the task's headless page (a desktop pane is the app's to close). */
  readonly close: (task: TaskId) => Effect.Effect<void>
  /** The download of the headless Chrome going, if one is. */
  readonly installing: Effect.Effect<ChromeInstalling | null>
  /** A ticket for the task's browser's socket (single use, for a minute). */
  readonly ticket: (task: TaskId, role: BrowserRole) => Effect.Effect<string, TaskNotFound>
  /**
   * The socket of `ticket`: its role checked, the request upgraded (`upgrade`), then a viewer's stream or the desktop
   * pane's relay, until the socket closes.
   */
  readonly serve: <E>(
    ticket: string,
    query: { readonly width: number; readonly height: number; readonly url: string | null },
    upgrade: Effect.Effect<Socket.Socket, E>,
  ) => Effect.Effect<void, BrowserTicketInvalid | E, Scope.Scope>
}

/** How long a ticket opens the socket. */
const TICKET_MS = 60_000
/** A headless page unused and unwatched this long closes. */
const IDLE_MS = 30 * 60_000
/** The headless page's size until a viewer gives its own. */
export const DEFAULT_SIZE = { width: 1280, height: 800 } as const
const BLANK = "about:blank"

interface Headless {
  /** The Chrome it is in (`Running.id`). */
  readonly chrome: number
  readonly targetId: string
  readonly page: CdpPage
  /** Its page's tracking, closed with it. */
  readonly scope: Scope.Closeable
}
interface Pane {
  readonly id: number
  readonly page: CdpPage
}
interface Tab {
  readonly headless: Headless | null
  readonly desktop: Pane | null
  readonly info: SubscriptionRef.SubscriptionRef<BrowserPage>
  /** Done when a desktop pane takes the tab, which ends the stream's viewers. */
  readonly taken: Deferred.Deferred<void>
  readonly usedAt: number
  readonly viewers: number
  readonly dialog: string | null
  readonly size: { readonly width: number; readonly height: number }
}
interface Running {
  /** Counts Chrome's starts: a page of an earlier one is gone. */
  readonly id: number
  readonly chrome: ChromeProcess
  readonly scope: Scope.Closeable
}

const setSize = (page: CdpPage, s: { readonly width: number; readonly height: number }) =>
  page.send("Emulation.setDeviceMetricsOverride", { width: s.width, height: s.height, deviceScaleFactor: 1, mobile: false }).pipe(Effect.ignore)

/** Read the page's address and title into `info`, when they changed. */
const refresh = (page: CdpPage, info: SubscriptionRef.SubscriptionRef<BrowserPage>) =>
  Effect.gen(function* () {
    const i = yield* pageInfo(page).pipe(Effect.option)
    if (Option.isNone(i)) return
    const p = yield* SubscriptionRef.get(info)
    const url = i.value.url || p.url
    if (url !== p.url || i.value.title !== p.title) yield* SubscriptionRef.set(info, { ...p, url, title: i.value.title })
  })

const sizeOf = (w: number, h: number) => ({ width: Math.max(200, Math.min(3840, Math.round(w))), height: Math.max(150, Math.min(2160, Math.round(h))) })

export class Browsers extends Context.Service<Browsers, BrowsersShape>()("huntaway-server/browser/Browsers") {
  static readonly layer = Layer.effect(
    Browsers,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const install = yield* ChromeInstall
      const tasks = yield* Tasks
      const fs = yield* FileSystem.FileSystem
      const random = yield* SecureRandom.SecureRandom
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const layerScope = yield* Effect.scope
      const tabs = yield* Ref.make<ReadonlyMap<TaskId, Tab>>(new Map())
      const running = yield* Ref.make<Running | null>(null)
      const lock = yield* Semaphore.make(1)
      const chromeLock = yield* Semaphore.make(1)
      const tickets = yield* Ref.make<ReadonlyMap<string, { readonly task: TaskId; readonly role: BrowserRole; readonly expires: number }>>(new Map())
      const paneIds = yield* Ref.make(0)
      const chromeIds = yield* Ref.make(0)
      const profileDir = `${config.dataDir}/browser/profile`

      const setTab = (task: TaskId, f: (t: Tab) => Tab) =>
        Ref.update(tabs, (m) => {
          const t = m.get(task)
          return t === undefined ? m : new Map([...m, [task, f(t)]])
        })
      const getTab = (task: TaskId) => Effect.map(Ref.get(tabs), (m) => m.get(task))

      /** The task's tab, made (with no page) if it has none. */
      const tabOf = (task: TaskId) =>
        Effect.gen(function* () {
          const found = yield* getTab(task)
          if (found !== undefined) return found
          const fresh: Tab = {
            headless: null,
            desktop: null,
            info: yield* SubscriptionRef.make<BrowserPage>({ url: BLANK, title: "", loading: false }),
            taken: yield* Deferred.make<void>(),
            usedAt: yield* Clock.currentTimeMillis,
            viewers: 0,
            dialog: null,
            size: DEFAULT_SIZE,
          }
          yield* Ref.update(tabs, (m) => new Map([...m, [task, fresh]]))
          return fresh
        })

      /** The headless Chrome, started if it isn't running. */
      const chrome = chromeLock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Ref.get(running)
          if (now !== null && (yield* now.chrome.cdp.status) === null) return now
          if (now !== null) yield* Scope.close(now.scope, Exit.void)
          const executable = yield* install.executable
          yield* fs.makeDirectory(profileDir, { recursive: true }).pipe(Effect.ignore)
          const scope = yield* Scope.fork(layerScope)
          const started = yield* startChrome({ executable, profileDir, sandbox: config.chromeSandbox }).pipe(
            Scope.provide(scope),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          )
          const alive = yield* started.cdp.send("Browser.getVersion", {}, undefined, "20 seconds").pipe(Effect.result)
          if (alive._tag === "Failure") {
            yield* Scope.close(scope, Exit.void)
            const said = (yield* started.stderr).trim().split("\n").slice(-3).join(" / ")
            const sandbox = /sandbox/iu.test(said) ? " Chrome's sandbox can't start here: set HUNTAWAY_CHROME_SANDBOX=0 in the server's environment." : ""
            return yield* new ChromeUnavailable({
              reason: `The headless browser didn't start: ${alive.failure.reason}${said === "" ? "" : ` (${said})`}.${sandbox}`,
            })
          }
          const r: Running = { id: yield* Ref.updateAndGet(chromeIds, (n) => n + 1), chrome: started, scope }
          yield* Ref.set(running, r)
          return r
        }),
      )

      /** Keep `info` up to date from `page`'s events; a headless page's dialogs are accepted, and remembered. */
      const track = (task: TaskId, page: CdpPage, info: SubscriptionRef.SubscriptionRef<BrowserPage>, headless: boolean) =>
        Effect.gen(function* () {
          const sub = yield* page.subscribe
          const tree = yield* page.send("Page.getFrameTree").pipe(Effect.orElseSucceed((): CdpResult => ({})))
          const mainFrame = isRecord(tree["frameTree"]) && isRecord(tree["frameTree"]["frame"]) ? str(tree["frameTree"]["frame"], "id") : ""
          const title = refresh(page, info)
          yield* PubSub.take(sub).pipe(
            Effect.flatMap((e) => {
              if (e.sessionId !== page.sessionId) return Effect.void
              const frame = isRecord(e.params["frame"]) ? e.params["frame"] : undefined
              switch (e.method) {
                case "Page.frameNavigated":
                  return frame !== undefined && frame["parentId"] === undefined
                    ? SubscriptionRef.update(info, (p) => ({ ...p, url: `${str(frame, "url")}${str(frame, "urlFragment")}` }))
                    : Effect.void
                case "Page.navigatedWithinDocument":
                  return str(e.params, "frameId") === mainFrame
                    ? Effect.andThen(
                        SubscriptionRef.update(info, (p) => ({ ...p, url: str(e.params, "url") })),
                        title,
                      )
                    : Effect.void
                case "Page.frameStartedLoading":
                  return str(e.params, "frameId") === mainFrame ? SubscriptionRef.update(info, (p) => ({ ...p, loading: true })) : Effect.void
                case "Page.frameStoppedLoading":
                  return str(e.params, "frameId") === mainFrame
                    ? Effect.andThen(
                        SubscriptionRef.update(info, (p) => ({ ...p, loading: false })),
                        title,
                      )
                    : Effect.void
                case "Page.domContentEventFired":
                  return title
                case "Page.javascriptDialogOpening":
                  return headless
                    ? Effect.andThen(
                        setTab(task, (t) => ({ ...t, dialog: `${str(e.params, "type")}: ${str(e.params, "message")}`.slice(0, 500) })),
                        page.send("Page.handleJavaScriptDialog", { accept: true }).pipe(Effect.ignore),
                      )
                    : Effect.void
                default:
                  return Effect.void
              }
            }),
            Effect.forever,
            Effect.forkScoped,
          )
          yield* title
        })

      /** A fresh headless page for `task`, at `url` (loaded after, outside the lock). */
      const openHeadless = (task: TaskId, tab: Tab) =>
        Effect.gen(function* () {
          const r = yield* chrome
          const cdp = r.chrome.cdp
          const made = yield* cdp.send("Target.createTarget", { url: BLANK })
          const targetId = str(made, "targetId")
          const page = pageOf(cdp, str(yield* cdp.send("Target.attachToTarget", { targetId, flatten: true }), "sessionId"))
          yield* preparePage(page)
          yield* setSize(page, tab.size)
          const scope = yield* Scope.fork(r.scope)
          yield* track(task, page, tab.info, true).pipe(Scope.provide(scope))
          yield* Scope.addFinalizer(scope, cdp.send("Target.closeTarget", { targetId }).pipe(Effect.ignore))
          const h: Headless = { chrome: r.id, targetId, page, scope }
          yield* setTab(task, (t) => ({ ...t, headless: h }))
          return h
        })

      /** Whether a headless page is still there (Chrome may have exited, or the page closed). */
      const alive = (h: Headless) =>
        Effect.flatMap(Ref.get(running), (r) => (r === null || r.id !== h.chrome ? Effect.succeed(false) : Effect.map(r.chrome.cdp.status, (s) => s === null)))

      const touch = (task: TaskId) => Effect.flatMap(Clock.currentTimeMillis, (now) => setTab(task, (t) => ({ ...t, usedAt: now })))

      /** The task's headless page (opened if it hasn't one), and the address to load into a fresh one. */
      const headlessOf = (task: TaskId, url: string | undefined) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const tab = yield* tabOf(task)
            if (tab.headless !== null && (yield* alive(tab.headless))) return { h: tab.headless, tab, load: null }
            if (tab.headless !== null) yield* Scope.close(tab.headless.scope, Exit.void)
            const was = (yield* SubscriptionRef.get(tab.info)).url
            const h = yield* openHeadless(task, tab)
            const load = was !== BLANK && was !== "" ? was : url !== undefined && url !== "" ? url : null
            return { h, tab, load }
          }),
        )

      const page: BrowsersShape["page"] = (task, url) =>
        Effect.gen(function* () {
          yield* tasks.get(task)
          yield* touch(task)
          const tab = yield* getTab(task)
          if (tab?.desktop != null) return { page: tab.desktop.page, backend: "desktop" as const }
          const { h, load } = yield* headlessOf(task, url)
          yield* touch(task)
          if (load !== null) yield* navigate(h.page, load).pipe(Effect.catchTag("PageRefused", () => Effect.void))
          return { page: h.page, backend: "headless" as const }
        })

      const closeHeadless = (task: TaskId) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const tab = yield* getTab(task)
            if (tab?.headless == null) return
            yield* setTab(task, (t) => ({ ...t, headless: null }))
            yield* Scope.close(tab.headless.scope, Exit.void)
          }),
        )

      /** Close the headless pages nobody has used or watched for `IDLE_MS`, and Chrome once it has none. */
      const reap = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        for (const [task, t] of yield* Ref.get(tabs)) {
          if (t.headless !== null && t.viewers === 0 && now - t.usedAt > IDLE_MS) yield* closeHeadless(task)
        }
        const left = [...(yield* Ref.get(tabs)).values()].some((t) => t.headless !== null)
        if (!left) {
          yield* chromeLock.withPermits(1)(
            Effect.gen(function* () {
              const r = yield* Ref.getAndSet(running, null)
              if (r !== null) yield* Scope.close(r.scope, Exit.void)
            }),
          )
        }
      })
      yield* reap.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped)

      const ticket: BrowsersShape["ticket"] = (task, role) =>
        Effect.gen(function* () {
          yield* tasks.get(task)
          const now = yield* Clock.currentTimeMillis
          const t = Array.from(yield* random.randomBytes(24), (b) => b.toString(16).padStart(2, "0")).join("")
          yield* Ref.update(tickets, (m) => new Map([...[...m].filter(([, x]) => x.expires > now), [t, { task, role, expires: now + TICKET_MS }]]))
          return t
        })

      const redeem = (t: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const found = yield* Ref.modify(tickets, (m) => {
            const next = new Map(m)
            next.delete(t)
            return [m.get(t), next] as const
          })
          if (found === undefined || found.expires <= now) return yield* new BrowserTicketInvalid()
          return found
        })

      /** A viewer of the task's headless page, until it goes or the desktop pane takes the tab. */
      const view = (
        task: TaskId,
        reader: Socket.Reader,
        writer: Socket.Writer,
        query: { readonly width: number; readonly height: number; readonly url: string | null },
      ) =>
        Effect.gen(function* () {
          const say = (text: string) => writer.write(text).pipe(Effect.ignore)
          const tab = yield* tabOf(task)
          if (tab.desktop !== null) return yield* say('{"type":"desktop"}')
          // A first page downloads Chrome: the viewer is told how that's going meanwhile.
          const progress = yield* Effect.gen(function* () {
            const p = yield* install.installing
            if (p !== null) yield* say(yield* toJson({ type: "installing", ...p }))
          }).pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.forkScoped)
          const got = yield* page(task, query.url ?? undefined).pipe(Effect.result)
          yield* Fiber.interrupt(progress)
          if (got._tag === "Failure") {
            const reason = got.failure._tag === "TaskNotFound" ? `There's no task ${got.failure.id}.` : got.failure.reason
            return yield* say(yield* toJson({ type: "error", message: reason }))
          }
          if (got.success.backend === "desktop") return yield* say('{"type":"desktop"}')
          const now = yield* getTab(task)
          const h = now?.headless
          const r = yield* Ref.get(running)
          if (now === undefined || h == null || r === null) return yield* say('{"type":"error","message":"The page has closed."}')
          yield* Effect.acquireRelease(
            setTab(task, (t) => ({ ...t, viewers: t.viewers + 1 })),
            () =>
              Effect.andThen(
                setTab(task, (t) => ({ ...t, viewers: t.viewers - 1 })),
                touch(task),
              ),
          )
          return yield* relayViewer(
            {
              cdp: r.chrome.cdp,
              targetId: h.targetId,
              main: h.page,
              info: now.info,
              taken: Deferred.await(now.taken),
              // A script may change the title with no event of the page's: it's looked at while someone watches.
              refresh: refresh(h.page, now.info),
              resize: (w, hgt) =>
                Effect.gen(function* () {
                  const s = sizeOf(w, hgt)
                  yield* setTab(task, (t) => ({ ...t, size: s }))
                  yield* setSize(h.page, s)
                  return s
                }),
              navigate: (url) => Effect.andThen(touch(task), navigate(h.page, url).pipe(Effect.mapError(reasonOf))),
              go: (go) => Effect.andThen(touch(task), history(h.page, go).pipe(Effect.mapError(reasonOf))),
            },
            reader,
            writer,
            sizeOf(query.width, query.height),
          )
        })

      /** The desktop app's pane for `task`, driven through the app's relay of its debugger, until the socket closes. */
      const attachDesktop = (task: TaskId, reader: Socket.Reader, writer: Socket.Writer) =>
        Effect.gen(function* () {
          const cdp: Cdp = yield* makeCdp(
            (m) => writer.write(m).pipe(Effect.ignore),
            socketText(reader),
            Effect.succeed("the desktop app's browser pane closed"),
          )
          const pane: Pane = { id: yield* Ref.updateAndGet(paneIds, (n) => n + 1), page: pageOf(cdp, undefined) }
          const ready = yield* preparePage(pane.page).pipe(Effect.result)
          if (ready._tag === "Failure") return
          const its = yield* pageInfo(pane.page).pipe(Effect.orElseSucceed(() => ({ url: "", title: "" })))
          const before = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              const tab = yield* tabOf(task)
              const was = (yield* SubscriptionRef.get(tab.info)).url
              // Viewers of the stream are told the pane has it now, and go.
              yield* Deferred.succeed(tab.taken, undefined)
              const taken = yield* Deferred.make<void>()
              yield* setTab(task, (t) => ({ ...t, desktop: pane, headless: null, taken }))
              if (tab.headless !== null) yield* Scope.close(tab.headless.scope, Exit.void)
              return { tab, was, hadHeadless: tab.headless !== null }
            }),
          )
          yield* Effect.addFinalizer(() => setTab(task, (t) => (t.desktop?.id === pane.id ? { ...t, desktop: null } : t)))
          yield* track(task, pane.page, before.tab.info, false)
          // The agent's page carries over to the pane.
          if (before.hadHeadless && before.was !== BLANK && before.was !== "" && before.was !== its.url)
            yield* navigate(pane.page, before.was).pipe(Effect.ignore)
          yield* touch(task)
          yield* cdp.closed
        })

      const serve: BrowsersShape["serve"] = (t, query, upgrade) =>
        Effect.gen(function* () {
          const found = yield* redeem(t)
          const socket = yield* upgrade
          const reader = yield* socket.reader.pipe(Effect.orDie)
          const writer = yield* socket.writer
          if (found.role === "desktop") return yield* attachDesktop(found.task, reader, writer)
          return yield* view(found.task, reader, writer, query)
        })

      return Browsers.of({
        page,
        state: (task) =>
          Effect.gen(function* () {
            const t = yield* getTab(task)
            if (t === undefined || (t.desktop === null && t.headless === null)) return null
            const p = yield* SubscriptionRef.get(t.info)
            return { ...p, backend: t.desktop !== null ? "desktop" : "headless", watching: t.viewers + (t.desktop !== null ? 1 : 0), dialog: t.dialog }
          }),
        close: closeHeadless,
        installing: install.installing,
        ticket,
        serve,
      })
    }),
  )
}

const reasonOf = (e: CdpError | PageRefused) => ({ reason: e.reason })
