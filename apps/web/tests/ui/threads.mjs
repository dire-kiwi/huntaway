// Threads for the browser checks: items and requests as the server's thread store keeps them, written into a test
// server's database before the page opens the thread.
//
// Why the database: the board writes a thread only from an agent's run (Runs, plan task 2.5) and the board's own
// messages around one, and this server has neither yet. The old checks served a thread from the page's side
// (`routeThread` answered `/api/tasks/<id>/thread` from a feed); the thread now comes over the RPC websocket, so it is
// put where the server reads it, as the old harness's `legacySubproject` wrote the database for what the API does not
// make. A thread written this way is read by the next `threads.watch` (a snapshot is a read of the tables); a watcher
// already open does not see it, so live updates wait for runs (the checks that need them are marked so).
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"

const AT = "2026-11-01T09:00:00.000Z"

/**
 * Appends `items` (and `requests`) to task `task`'s thread in `server`'s database, as `ThreadStore.append` would leave
 * them, and moves the thread's seq on by as many. Call it before the page opens the thread.
 */
export function seedThread(server, task, items, requests = []) {
  const db = new DatabaseSync(join(server.dataDir, "board.db"))
  try {
    db.exec("PRAGMA busy_timeout = 5000")
    db.exec("BEGIN IMMEDIATE")
    const seq = db.prepare("SELECT seq FROM threads WHERE task_id = ?").get(task.id)?.seq ?? 0
    db.prepare("INSERT INTO threads (task_id, seq, created_at) VALUES (?, ?, ?) ON CONFLICT (task_id) DO UPDATE SET seq = excluded.seq").run(
      task.id,
      seq + items.length + requests.length,
      AT,
    )
    const next = (table) => db.prepare(`SELECT COALESCE(MAX(pos) + 1, 0) AS n FROM ${table} WHERE task_id = ?`).get(task.id).n
    const itemAt = next("thread_items")
    const item = db.prepare(
      "INSERT INTO thread_items (task_id, id, pos, type, parent_id, write_no, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)",
    )
    items.forEach((it, i) => item.run(task.id, it.id, itemAt + i, it.type, it.parent_id ?? null, JSON.stringify(it), it.created_at ?? AT, AT))
    const requestAt = next("thread_requests")
    const request = db.prepare(
      "INSERT INTO thread_requests (task_id, id, pos, type, tool_call_id, write_no, open, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)",
    )
    requests.forEach((r, i) =>
      request.run(task.id, r.id, requestAt + i, r.type, r.tool_call_id ?? null, r.resolution ? 0 : 1, JSON.stringify(r), r.created_at ?? AT, AT),
    )
    db.exec("COMMIT")
  } finally {
    db.close()
  }
}

/** `n` replies of the agent's, `Reply <from>` first. */
export const replies = (n, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: `legacy:${from + i + 1}:0`, type: "assistant_message", text: `Reply ${from + i}` }))

/**
 * A thread with one of each thing the thread draws from items: the user's message, the agent's Markdown and thinking,
 * tool calls (a command with its output, one that failed, an edit), a subagent with its own items, a notice, a
 * compaction and a turn's end; and the requests a run asks (a permission and a question), drawn as their cards.
 */
export function sampleThread() {
  const items = [
    { id: "legacy:1", type: "user_message", text: "Find where the board keeps its config, and tidy it." },
    { id: "legacy:2:0", type: "reasoning", text: "The config is probably read at startup." },
    { id: "legacy:2:1", type: "assistant_message", text: "Looking around first. The **config** is read in `ServerConfig.ts`:\n\n- flags\n- the environment" },
    {
      id: "toolu_ls",
      type: "tool_call",
      name: "Bash",
      kind: "shell",
      input: { command: "ls src" },
      command: "ls src",
      status: "completed",
      result: { content: "Main.ts\nplatform" },
    },
    {
      id: "toolu_cat",
      type: "tool_call",
      name: "Bash",
      kind: "shell",
      input: { command: "cat nowhere" },
      command: "cat nowhere",
      status: "failed",
      result: { content: "cat: nowhere: No such file or directory" },
    },
    {
      id: "toolu_edit",
      type: "tool_call",
      name: "Edit",
      kind: "edit",
      input: { file_path: "/repo/src/config.ts", old_string: "const port = 1", new_string: "const port = 2" },
      status: "completed",
      result: { content: "The file was updated." },
    },
    {
      id: "toolu_agent",
      type: "tool_call",
      name: "Agent",
      kind: "subagent",
      input: { description: "Explore config", prompt: "Find the config." },
      title: "Explore config",
      status: "completed",
      result: { content: "Report: it's in config.rs" },
      subagent: { status: "completed" },
    },
    { id: "legacy:3:0", type: "assistant_message", text: "Subagent's first finding.", parent_id: "toolu_agent" },
    { id: "legacy:4", type: "notice", level: "info", text: "The task moved to In review" },
    { id: "legacy:5", type: "compaction", trigger: "auto", tokens_before: 120000 },
    { id: "legacy:6:0", type: "assistant_message", text: "All done: the config is tidy." },
    { id: "legacy:6:result", type: "turn_result", ok: true, duration_ms: 4200, metadata: { num_turns: 3, total_cost_usd: 0.012 } },
    { id: "toolu_rm", type: "tool_call", name: "Bash", kind: "shell", input: { command: "rm -rf build" }, command: "rm -rf build", status: "pending" },
  ]
  const requests = [
    { id: "prompt-1", type: "permission", tool_call_id: "toolu_rm", name: "Bash", kind: "shell", input: { command: "rm -rf build" } },
    {
      id: "prompt-2",
      type: "question",
      questions: [{ id: "q1", question: "Which config format should it use?", header: "Format", options: [{ label: "TOML" }, { label: "JSON" }] }],
    },
  ]
  return { items, requests }
}
