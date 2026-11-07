// The desktop's journal (HA-273, see desktop.ts): what each task's agent did on the host's desktop through the
// `desktop` MCP server (mcp/desktop_mcp.ts): its actions, launches and clipboard writes, not its reads. An action the
// agent named (`op_id`) is run at most once: a retry after a lost answer gets the recorded one.
import { all, one, run, type Conn } from "../db.ts";
import { BUILD_ID } from "../hosts/proto.ts";
import { new_id, now } from "../util.ts";

/** The table (migration 107). */
export const DESKTOP_SCHEMA = `
CREATE TABLE IF NOT EXISTS desktop_ops (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT,
  op_id TEXT,
  tool TEXT NOT NULL,
  summary TEXT NOT NULL,
  args TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  boot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS desktop_ops_op ON desktop_ops(task_id, op_id) WHERE op_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS desktop_ops_task ON desktop_ops(task_id, created_at);
`;

/** `running`, then `ok` or `failed`; `interrupted` for one that was running when the server stopped. */
export type OpStatus = "running" | "ok" | "failed" | "interrupted";

export interface DesktopOp {
  id: string;
  task_id: string;
  run_id: string | null;
  /** The agent's name for it, if it gave one. */
  op_id: string | null;
  /** Our tool: `act`, `launch` or `clipboard`. */
  tool: string;
  /** A line saying what it did, for the board. */
  summary: string;
  args: any;
  status: OpStatus;
  /** Its text, as the agent got it (images aren't kept). */
  result: string | null;
  created_at: string;
  finished_at: string | null;
}

function from_row(r: any): DesktopOp {
  let args: any = null;
  try {
    args = JSON.parse(r.args);
  } catch {}
  // One left running by an earlier process was cut short: whether it took effect isn't known.
  const status = r.status === "running" && r.boot !== BUILD_ID ? "interrupted" : r.status;
  return {
    id: r.id,
    task_id: r.task_id,
    run_id: r.run_id,
    op_id: r.op_id,
    tool: r.tool,
    summary: r.summary,
    args,
    status,
    result: r.result,
    created_at: r.created_at,
    finished_at: r.finished_at,
  };
}

/** Record an op as it starts. */
export function start_op(c: Conn, o: { task_id: string; run_id: string | null; op_id: string | null; tool: string; summary: string; args: any }): DesktopOp {
  const id = new_id();
  run(
    c,
    "INSERT INTO desktop_ops (id, task_id, run_id, op_id, tool, summary, args, status, boot, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running', ?8, ?9)",
    id,
    o.task_id,
    o.run_id,
    o.op_id,
    o.tool,
    o.summary,
    JSON.stringify(o.args ?? null),
    BUILD_ID,
    now(),
  );
  return get_op(c, id)!;
}

export function finish_op(c: Conn, id: string, status: "ok" | "failed", result: string): void {
  run(c, "UPDATE desktop_ops SET status=?2, result=?3, finished_at=?4 WHERE id=?1", id, status, result, now());
}

export function get_op(c: Conn, id: string): DesktopOp | null {
  const r = one(c, "SELECT * FROM desktop_ops WHERE id=?1", id);
  return r ? from_row(r) : null;
}

/** Task `task_id`'s op that the agent named `op_id`. */
export function find_op(c: Conn, task_id: string, op_id: string): DesktopOp | null {
  const r = one(c, "SELECT * FROM desktop_ops WHERE task_id=?1 AND op_id=?2", task_id, op_id);
  return r ? from_row(r) : null;
}

/** A task's latest ops, newest first. */
export function task_ops(c: Conn, task_id: string, limit = 50): DesktopOp[] {
  return all(c, "SELECT * FROM desktop_ops WHERE task_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2", task_id, limit).map(from_row);
}
