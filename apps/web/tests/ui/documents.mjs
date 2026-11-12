// Shared by the checks of a task's documents (plan.test.mjs, planDiagrams.test.mjs, planTheme.test.mjs,
// documentCsp.test.mjs; 6.2). They run on the demo board (`--demo`), which has a plan, a diagram and an artifact with a
// version of each, as the old checks did. The old checks routed `/tasks/{id}/document` and `/tasks/{id}/messages` with
// `page.route`; these answer the `tasks.document` and `tasks.send` RPCs on the page's websocket (`routeDocuments`).
// Agents are off, so a send is answered here, with the task as it is: what was sent is recorded.
import { success } from "./harness.mjs"

/** The demo board's project and its tasks, by title. */
export async function demoBoard(server) {
  const [profile] = await server.rpc("profiles.list")
  const [project] = await server.rpc("projects.list", { profile_id: profile.id })
  const tasks = await server.rpc("tasks.list", { filter: { _tag: "ByProject", project_id: project.id } })
  return { project, tasks: Object.fromEntries(tasks.map((t) => [t.title, t])) }
}

export const PLAN = "Plan a dark mode for the demo site"
export const DIAGRAM = "How a task moves across the board"

/** A `tasks.document` answer: version 1 (or `versions`) of a plan with `content`. */
export const planDocument = (content, { open = false, versions = null, version = 1 } = {}) => {
  const at = new Date().toISOString()
  return {
    label: "plan",
    file: "plan.html",
    versions: versions ?? [{ version: 1, open, created_at: at, updated_at: at, size: content.length }],
    version,
    content,
  }
}

/**
 * Sits between the page and its server on the RPC websocket, for `task`. `document(payload)`, if given, answers its
 * `tasks.document` (undefined lets it through); its `tasks.send` is recorded in `sent` (the texts) and answered with the
 * task, once `hold()` (if given) resolves. `push(event)` gives the page a board event, as its server would. Call it
 * before the page opens.
 */
export async function routeDocuments(page, server, task, { document, hold } = {}) {
  const sent = []
  const sockets = []
  await page.routeWebSocket(/\/api\/rpc$/, (ws) => {
    const at = { ws, watch: null, acks: 0 }
    sockets.push(at)
    const upstream = ws.connectToServer()
    ws.onMessage((message) => {
      for (const line of String(message).split("\n").filter(Boolean)) {
        const r = JSON.parse(line)
        // The page's acknowledgement of a chunk this gave it, which its server never sent.
        if (r._tag === "Ack" && r.requestId === at.watch && at.acks > 0) {
          at.acks--
          continue
        }
        const answer = (value) => ws.send(`${JSON.stringify({ _tag: "Exit", requestId: r.id, exit: success(value) })}\n`)
        if (r._tag === "Request" && r.tag === "board.watch") at.watch = r.id
        if (r._tag === "Request" && r.tag === "tasks.document" && r.payload.id === task.id && document) {
          const doc = document(r.payload)
          if (doc !== undefined) {
            answer(doc)
            continue
          }
        }
        if (r._tag === "Request" && r.tag === "tasks.send" && r.payload.id === task.id) {
          sent.push(r.payload.text)
          void Promise.resolve(hold?.()).then(async () => answer(await server.rpc("tasks.get", { id: task.id })))
          continue
        }
        upstream.send(`${line}\n`)
      }
    })
  })
  const push = (event) => {
    const at = sockets.findLast((s) => s.watch !== null)
    at.acks++
    at.ws.send(`${JSON.stringify({ _tag: "Chunk", requestId: at.watch, values: [event] })}\n`)
  }
  return { sent, push }
}

/** The page's own frames: the document's (the first), and the frames in it. */
export const docFrame = (page) => page.frames().find((f) => f !== page.mainFrame() && f.parentFrame() === page.mainFrame())

/** The answers kept in the browser for the plan, as stored. */
export const saved = (page) => page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith("ia.planAnswers"))?.[1] ?? "{}"))
