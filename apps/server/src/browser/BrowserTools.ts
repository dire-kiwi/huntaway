import { Effect } from "effect"
import { browserUrl } from "@huntaway/shared"
import type { TaskId } from "@huntaway/contracts"
import { text } from "../desktop/cua.ts"
import type { DesktopContent } from "../desktop/cua.ts"
import { localToolHandler, McpServers } from "../mcp/McpServers.ts"
import type { LocalCaller } from "../mcp/tool.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { Browsers } from "./Browsers.ts"
import { pinnedRelease } from "./ChromeInstall.ts"
import type { BrowserState } from "./Browsers.ts"
import type { CdpError, CdpPage } from "./cdp.ts"
import type { ChromeUnavailable } from "./ChromeInstall.ts"
import { click, clickAt, evaluate, history, hover, navigate, pageInfo, press, screenshot, scroll, snapshot, type } from "./page.ts"
import type { PageRefused } from "./page.ts"
import { Click, Close, Evaluate, Hover, Navigate, Press, Screenshot, Scroll, Snapshot, Type } from "./tools.ts"

// The `browser` server's handlers (HE-62): each run's tools act on its task's page (`Browsers.page`), which they open
// headless when the task has none. After an action the agent is told where the page is now; what it shows is
// `snapshot`'s or `screenshot`'s to say. A failure (Chrome can't start, a ref that's gone, a page that didn't load) is
// an error result with the reason, never a failed call.

type Failure = ChromeUnavailable | CdpError | PageRefused | { readonly _tag: "TaskNotFound"; readonly id: string }

const reason = (e: Failure) => (e._tag === "TaskNotFound" ? `The task ${e.id} is gone.` : e.reason)

/** Where the page is, as the agent is told after an action. */
const where = (s: BrowserState | null, url: string, title: string, dialog: string | null) => {
  const place = s?.backend === "desktop" ? " (in the user's desktop app, beside the thread)" : ""
  const shown = title === "" ? url : `${title} (${url})`
  const said = dialog === null ? "" : `\nThe page showed a dialog, which was accepted: ${dialog}`
  return `The page is now ${shown}${place}.${said}`
}

export const browserTools = Effect.gen(function* () {
  const browsers = yield* Browsers
  const config = yield* ServerConfig
  // Served wherever a headless Chrome can run: one is named, or Chrome for Testing has one for this platform.
  yield* (yield* McpServers).serveWhen("browser", Effect.succeed(config.chromeBin !== null || pinnedRelease(config.platform) !== null))

  /** `body` on the caller's task's page, answered with the page's place after (unless `body` gives the answer). */
  const on = (caller: LocalCaller, body: (page: CdpPage) => Effect.Effect<DesktopContent | string | void, Failure>, url?: string) =>
    Effect.gen(function* () {
      const task: TaskId = caller.task.id
      const { page } = yield* browsers.page(task, url)
      const said = yield* body(page)
      if (typeof said === "object") return said
      const info = yield* pageInfo(page).pipe(Effect.orElseSucceed(() => ({ url: "", title: "" })))
      const now = where(yield* browsers.state(task), info.url, info.title, yield* browsers.takeDialog(task))
      return text(typeof said === "string" ? `${said}\n${now}` : now)
    }).pipe(Effect.catch((e) => Effect.succeed(text(reason(e), true))))

  return [
    localToolHandler(Navigate, (a, caller) => {
      if (a.go !== undefined) {
        const go = a.go
        return on(caller, (page) => history(page, go))
      }
      const url = browserUrl(a.url ?? "")
      if (url === null) return Effect.succeed(text(`${a.url ?? "(nothing)"} isn't a web address: give a URL, a host, or a port on this machine.`, true))
      return on(caller, (page) => navigate(page, url))
    }),
    localToolHandler(Snapshot, (_a, caller) =>
      on(caller, (page) =>
        Effect.gen(function* () {
          const info = yield* pageInfo(page)
          const outline = yield* snapshot(page)
          const head = info.title === "" ? info.url : `${info.title} (${info.url})`
          return text(`${head}\n\n${outline === "" ? "(The page shows nothing an outline can say: take a screenshot.)" : outline}`)
        }),
      ),
    ),
    localToolHandler(Click, (a, caller) => {
      const count = a.double === true ? 2 : 1
      if (a.ref !== undefined) {
        const r = a.ref
        return on(caller, (page) => Effect.as(click(page, r, count), `Clicked ${r}.`))
      }
      if (a.x === undefined || a.y === undefined) return Effect.succeed(text("Give a ref from the snapshot, or both x and y.", true))
      const at = { x: a.x, y: a.y }
      return on(caller, (page) => Effect.as(clickAt(page, at, count), `Clicked at ${at.x}, ${at.y}.`))
    }),
    localToolHandler(Type, (a, caller) =>
      on(caller, (page) =>
        Effect.as(
          type(page, a.ref, a.text, a.clear === true, a.submit === true),
          `Typed ${a.text.length} characters${a.ref === undefined ? "" : ` into ${a.ref}`}.`,
        ),
      ),
    ),
    localToolHandler(Press, (a, caller) => on(caller, (page) => Effect.as(press(page, a.key), `Pressed ${a.key}.`))),
    localToolHandler(Hover, (a, caller) => on(caller, (page) => Effect.as(hover(page, a.ref), `The mouse is over ${a.ref}.`))),
    localToolHandler(Scroll, (a, caller) =>
      on(caller, (page) => Effect.as(scroll(page, a.ref, a.dx ?? 0, a.dy ?? (a.ref === undefined ? 600 : 0)), "Scrolled.")),
    ),
    localToolHandler(Evaluate, (a, caller) =>
      on(caller, (page) => Effect.map(evaluate(page, a.expression), (r) => text(r.ok ? r.text : `It threw: ${r.text}`, !r.ok))),
    ),
    localToolHandler(Screenshot, (_a, caller) =>
      on(caller, (page) =>
        Effect.gen(function* () {
          const info = yield* pageInfo(page)
          const data = yield* screenshot(page)
          return {
            content: [
              { type: "image", data, mimeType: "image/png" },
              { type: "text", text: info.title === "" ? info.url : `${info.title} (${info.url})` },
            ],
          }
        }),
      ),
    ),
    localToolHandler(Close, (_a, caller) =>
      Effect.gen(function* () {
        const s = yield* browsers.state(caller.task.id)
        if (s?.backend === "desktop") return text("The task's browser is the user's desktop app pane: it's theirs to close.", true)
        yield* browsers.close(caller.task.id)
        return text(s === null ? "The task's browser wasn't open." : "Closed the task's browser.")
      }),
    ),
  ]
})

/** The `browser` server's tools, registered (`Main.ts`, above the MCP area: browser is below mcp in the dependency order). */
export const BrowserTools = McpServers.register("browser", browserTools)
