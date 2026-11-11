import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"

// 6.11: a fake Asana API for tests (docs/plan/10-testing.md, packages/testing), plain Node as the other programs here
// that stand in for outside ones: the old `integrations/asana/tests.ts`. It takes one token, has two workspaces (100:
// "Fix login" done and "Fix signup" open; 200: "Write docs"), and answers `/users/me`, each workspace's typeahead for
// tasks, and a task by its gid. src/fakeAsana.ts has it for a test's scope; a browser check can start it itself. Give its
// URL to the server (`ServerConfig.asanaUrl`, `HUNTAWAY_ASANA_URL`).

/** The token the fake Asana takes. */
export const ASANA_TOKEN = "good-token"

/** A task as Asana's API has it. */
export const asanaTaskJson = (gid: string, name: string, completed: boolean, notes = `Notes for ${name}`) => ({
  gid,
  name,
  completed,
  permalink_url: `https://app.asana.com/0/1/${gid}`,
  notes,
  assignee: { name: "Ivy" },
  projects: [{ name: "Web" }],
  workspace: { name: "Acme" },
})

/** What the fake has: each workspace's tasks, and the tasks that can be read by gid. */
export interface FakeAsanaData {
  readonly workspaces: Readonly<Record<string, ReadonlyArray<ReturnType<typeof asanaTaskJson>>>>
}

export const DEFAULT_ASANA: FakeAsanaData = {
  workspaces: {
    "100": [asanaTaskJson("1001", "Fix login", true), asanaTaskJson("1002", "Fix signup", false)],
    "200": [asanaTaskJson("2001", "Write docs", false)],
  },
}

const answer = (data: FakeAsanaData, req: IncomingMessage, res: ServerResponse) => {
  const send = (status: number, v: unknown) => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(v))
  }
  if (req.headers.authorization !== `Bearer ${ASANA_TOKEN}`) return send(401, { errors: [{ message: "Not Authorized" }] })
  const url = new URL(req.url ?? "/", "http://x")
  if (url.pathname === "/users/me") {
    const workspaces = Object.keys(data.workspaces).map((gid) => ({ gid }))
    return send(200, { data: { gid: "9", name: "Ivy", email: "ivy@example.com", workspaces } })
  }
  const typeahead = /^\/workspaces\/([^/]+)\/typeahead$/.exec(url.pathname)
  if (typeahead !== null) {
    if (url.searchParams.get("resource_type") !== "task") return send(500, { errors: [{ message: "resource_type must be task" }] })
    const query = (url.searchParams.get("query") ?? "").toLowerCase()
    return send(200, { data: (data.workspaces[typeahead[1] ?? ""] ?? []).filter((t) => t.name.toLowerCase().includes(query)) })
  }
  const task = /^\/tasks\/([^/]+)$/.exec(url.pathname)
  if (task !== null) {
    const found = Object.values(data.workspaces)
      .flat()
      .find((t) => t.gid === task[1])
    return found === undefined ? send(404, { errors: [{ message: "Unknown object" }] }) : send(200, { data: found })
  }
  return send(404, { errors: [{ message: "no such route" }] })
}

/** Starts a fake Asana on a free port of 127.0.0.1: its base URL, and how to stop it. */
export const startFakeAsana = (data: FakeAsanaData = DEFAULT_ASANA): Promise<{ readonly url: string; readonly close: () => void }> =>
  new Promise((resolve) => {
    const server = createServer((req, res) => answer(data, req, res))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() })
    })
  })
