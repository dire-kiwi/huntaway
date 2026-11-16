import { Effect, Schema } from "effect"

// The page a window shows while there is no board to show yet: the app is starting a server or waiting for one, or
// quitting to relaunch after an update (HE-44). Like the error page it is a `data:` URL, in the board's dark theme. It
// says what is happening, with a progress bar (filled where the step's share is known, moving otherwise), that it can
// take a minute and the window is not to be reloaded, and the server's output folded away. The main process loads it
// once and then calls `huntawayProgress(state)` in it (`progressScript`) as the start moves on.

/** What the page shows. */
export const ProgressState = Schema.Struct({
  /** What the app is doing as a whole: "Starting Huntaway", "Installing Huntaway 0.0.5". */
  heading: Schema.String,
  /** The step now: "Backing up the database". */
  step: Schema.String,
  detail: Schema.NullOr(Schema.String),
  /** 0 to 1, or null when the step's share isn't known. */
  share: Schema.NullOr(Schema.Finite),
  /** The server's last lines of output. */
  log: Schema.Array(Schema.String),
})
export interface ProgressState extends Schema.Schema.Type<typeof ProgressState> {}

/** The state as a script literal: JSON, with `<` escaped so that it can't end the script element. */
const literal = (state: ProgressState) =>
  Schema.encodeEffect(Schema.fromJsonString(ProgressState))(state).pipe(
    Effect.map((json) => json.replaceAll("<", "\\u003c")),
    Effect.orDie,
  )

/** The script that shows `state` in a window on the page. */
export const progressScript = (state: ProgressState): Effect.Effect<string> =>
  Effect.map(literal(state), (json) => `window.huntawayProgress && window.huntawayProgress(${json})`)

const style = `
  :root { color-scheme: dark }
  body { margin: 0; background: #0b0b0e; color: #e6e6ec; font: 14px/1.5 system-ui, sans-serif; display: flex; justify-content: center }
  main { width: min(640px, 100% - 64px); margin-top: 18vh }
  .brand { display: flex; align-items: center; gap: 8px; color: #9a9aab; font-size: 13px; margin-bottom: 18px }
  .brand i { width: 10px; height: 10px; border-radius: 3px; background: #6366f1; display: inline-block }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 18px }
  #step { font-weight: 500 }
  #detail { color: #9a9aab; font-size: 13px; min-height: 1.5em }
  .bar { position: relative; height: 6px; border-radius: 3px; background: #24242e; overflow: hidden; margin: 10px 0 18px }
  .bar > div { position: absolute; inset: 0 auto 0 0; border-radius: 3px; background: #6366f1; transition: width .3s ease }
  .bar.moving > div { width: 30% !important; animation: move 1.4s ease-in-out infinite }
  @keyframes move { from { left: -30% } to { left: 100% } }
  .note { color: #9a9aab; font-size: 13px; margin: 0 0 22px }
  details { color: #9a9aab; font-size: 13px }
  summary { cursor: pointer; user-select: none }
  pre { white-space: pre-wrap; word-break: break-word; font: 12px/1.45 ui-monospace, monospace; color: #c8c8d0; background: #16161d;
        border: 1px solid #24242e; border-radius: 8px; padding: 12px; max-height: 40vh; overflow: auto; margin: 8px 0 0 }
  @media (prefers-reduced-motion: reduce) { .bar.moving > div { animation-duration: 4s } }
`

// Sets text only (never HTML): the log is the server's output.
const script = `
  const $ = (id) => document.getElementById(id)
  window.huntawayProgress = (s) => {
    document.title = s.heading
    $("heading").textContent = s.heading + "\\u2026"
    $("step").textContent = s.step
    $("detail").textContent = s.detail ?? ""
    const bar = $("bar")
    bar.classList.toggle("moving", s.share === null)
    bar.firstElementChild.style.width = s.share === null ? "" : Math.round(Math.max(0, Math.min(1, s.share)) * 100) + "%"
    bar.setAttribute("aria-valuenow", s.share === null ? "" : String(Math.round(s.share * 100)))
    $("lines").textContent = s.log.length === 0 ? "nothing yet" : s.log.length + (s.log.length === 1 ? " line" : " lines")
    const pre = $("log")
    const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4
    pre.textContent = s.log.length > 0 ? s.log.join("\\n") : "Nothing yet."
    if (atEnd) pre.scrollTop = pre.scrollHeight
  }
  $("output").addEventListener("toggle", () => { const pre = $("log"); pre.scrollTop = pre.scrollHeight })
`

/** The page as a `data:` URL, showing `state` from the start. */
export const progressPage = Effect.fnUntraced(function* (state: ProgressState) {
  const json = yield* literal(state)
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Huntaway</title><style>${style}</style></head>
<body><main>
  <div class="brand"><i></i>Huntaway</div>
  <h1 id="heading"></h1>
  <div id="step" role="status" aria-live="polite"></div>
  <div id="detail"></div>
  <div id="bar" class="bar moving" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100"><div></div></div>
  <p class="note">This can take a minute, longer on a big board. Please wait, and don't reload or close this window:
  the board opens here by itself once the server is ready.</p>
  <details id="output"><summary>The server's output (<span id="lines"></span>)</summary><pre id="log"></pre></details>
</main>
<script>${script}
window.huntawayProgress(${json})</script></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
})
