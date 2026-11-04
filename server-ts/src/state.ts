// Port of server/src/state.rs: the server's shared state.
import { join } from "node:path";
import * as db from "./db.ts";
import type { Conn, Message, Task } from "./db.ts";
import type { Router } from "./http.ts";
import type { ServerMeta, RestartJob, Deployed } from "./update/admin.ts";
import { Releases } from "./update/release.ts";
import { PushState } from "./integrations/push.ts";
import { Relocations } from "./git/relocate.ts";
import * as worktree from "./git/worktree.ts";
import * as status_script from "./integrations/status_script.ts";
import * as task_tmp from "./agent/task_tmp.ts";

export { ApiError } from "./http.ts";

/** A broadcast channel: every subscriber gets every value sent after it subscribed. */
export class Broadcast<T = any> {
  private subs = new Set<(v: T) => void>();
  send(v: T) {
    for (const f of [...this.subs]) {
      try {
        f(v);
      } catch (e) {
        console.error("event subscriber:", e);
      }
    }
  }
  /** Returns the unsubscribe function. */
  subscribe(f: (v: T) => void): () => void {
    this.subs.add(f);
    return () => this.subs.delete(f);
  }
  receiver_count() {
    return this.subs.size;
  }
}

/** A run that hasn't finished. Its durable state lives in the `runs` table. */
export interface RunHandle {
  run_id: string;
  /** Aborts the run while it is still being prepared (before claude starts). */
  cancel: (() => void) | null;
}

export interface Identity {
  host_id: string;
  host_name: string;
  /** API token for this host (UI, hubs linking to us, agents' MCP helper). */
  token: string;
  /** Lets other hosts dial in to this node as a hub. */
  hub_token: string;
  /** Loopback URL agents' MCP helper uses to reach us. */
  internal_url: string;
}

/** An async mutex (tokio::sync::Mutex<()>): `await m.lock()` returns the release function. */
export class AsyncMutex {
  private last: Promise<void> = Promise.resolve();
  private held = false;
  async lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.last;
    this.last = prev.then(() => next);
    await prev;
    this.held = true;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.held = false;
      release();
    };
  }
  /** The release function if it isn't held, else null (try_lock). */
  try_lock(): (() => void) | null {
    if (this.held) return null;
    this.held = true;
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    this.last = this.last.then(() => next);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.held = false;
      release();
    };
  }
  is_locked() {
    return this.held;
  }
}

export class AppState {
  private conn: Conn;
  data_dir: string;
  host_id: string;
  host_name: string;
  token: string;
  hub_token: string;
  internal_url: string;
  /** The command that runs this server (`bin/huntaway`), for agents' MCP helper and the like. */
  exe: string;
  /** This host's events (threads, tasks, projects). */
  events = new Broadcast<any>();
  /** Events from every host on the board, tagged with host_id, for the UI. */
  hub_events = new Broadcast<any>();
  /** Active runs by task id. */
  runs = new Map<string, RunHandle>();
  /** Connected linked hosts by host id. */
  links = new Map<string, any>();
  /** Connection loops for outbound links, by host id (their stop functions). */
  link_tasks = new Map<string, () => void>();
  /** This host's API, for answering tunnelled and proxied requests in-process. */
  local_router: Router | null = null;
  /** Where this host is reached through the broker it dials, if any. */
  broker_url: string | null = null;
  /** Calls waiting on a permission request's decision, by request id. */
  perm_waiters = new Map<string, Array<() => void>>();
  /** MCP calls being executed, with duplicate deliveries waiting on the result. */
  calls_inflight = new Map<string, Array<(r: { ok: any } | { err: string }) => void>>();
  meta: ServerMeta;
  restart: RestartJob | null = null;
  /** What `--update-from` last reported (see admin::start_update_check). */
  deployed: Deployed | null = null;
  /** What the release checks found (see update/release.ts). */
  release: Releases;
  /** Claude usage limits by Claude config id. */
  usage = new Map<string, any>();
  /** Held while a project is created or changed (see api::update_project_inner). */
  project_changes = new AsyncMutex();
  /** The projects whose folders are moving, and those whose folders are kept where they are meanwhile. */
  relocating: Relocations;
  /** The tasks being deleted (by how many deletions), which no task can be added to meanwhile. */
  deleting = new Map<string, number>();
  /** Web Push to devices (see integrations/push.ts). */
  push: PushState;
  /** Run when the state goes (tests: removes its data dir). */
  cleanup: Array<() => void> = [];

  constructor(conn: Conn, data_dir: string, id: Identity, meta: ServerMeta, exe?: string) {
    this.conn = conn;
    this.data_dir = data_dir;
    this.host_id = id.host_id;
    this.host_name = id.host_name;
    this.token = id.token;
    this.hub_token = id.hub_token;
    this.internal_url = id.internal_url;
    this.exe = exe ?? default_exe();
    this.meta = meta;
    this.release = new Releases();
    this.relocating = new Relocations();
    this.push = new PushState();
  }

  /** `new`, for a server whose binary is `exe`. */
  static with_exe(conn: Conn, data_dir: string, id: Identity, meta: ServerMeta, exe: string) {
    return new AppState(conn, data_dir, id, meta, exe);
  }

  /** The database. One thread, so no lock. */
  db(): Conn {
    return this.conn;
  }

  emit(ev: any) {
    this.events.send(ev);
  }

  emit_task(t: Task) {
    this.emit({ type: "task", task: t });
  }

  emit_message(m: Message) {
    this.emit({ type: "message", task_id: m.task_id, message: m });
  }

  /** Insert a message and broadcast it. */
  add_message(task_id: string, kind: string, data: any): Message {
    const m = db.insert_message(this.db(), task_id, kind, data);
    this.emit_message(m);
    return m;
  }

  /** Informational line in a thread (worktree setup, errors, status changes). */
  add_event(task_id: string, level: string, text: string, detail: string | null = null) {
    try {
      this.add_message(task_id, "event", { level, text, detail });
    } catch {}
  }

  update_task(id: string, fields: Array<[string, any]>): Task | null {
    return this.update_task_if(id, fields, () => true);
  }

  /** `update_task`, if `when` holds. Null if it doesn't hold (or there's no task). */
  update_task_if(id: string, fields: Array<[string, any]>, when: (c: Conn) => boolean): Task | null {
    const c = this.db();
    if (!when(c)) return null;
    const old_status = fields.some(([k]) => k === "status") ? (db.get_task(c, id)?.status ?? null) : null;
    fields = [...fields];
    const preview = preview_following_pr(c, id, fields);
    if (preview !== undefined) fields.push(["preview_url", preview]);
    const t = db.update_task(c, id, fields);
    if (!t) return null;
    if (old_status !== null) this.status_changed(c, t, old_status);
    this.emit_task(t);
    const finished = old_status !== null && old_status !== "done" && t.status === "done";
    // The tasks stacked on it keep where they took its branch up to, which may well be deleted now.
    if (finished) {
      worktree.keep_starts(this, t.id).catch((e: any) => console.error(`keeping the starts of tasks on ${t.id}:`, e));
    }
    // A task done with its agents gives up its temp folder.
    if (fields.some(([k]) => k === "status" || k === "running")) this.task_changed(t);
    // A subproject follows its tasks' columns (and its own agent's).
    if (t.kind === "task" && fields.some(([k]) => ["status", "running", "attention_reason", "merging", "subproject"].includes(k))) {
      const sync = (id: string) => {
        try {
          return this.sync_subproject(id);
        } catch (e) {
          console.error(`updating subproject ${id}'s status:`, e);
          return null;
        }
      };
      if (t.parent_id) sync(t.parent_id);
      if (t.subproject) return sync(t.id) ?? t;
    }
    return t;
  }

  /** Move a subproject to the column its tasks put it in (see db::subproject_status). Returns it if it moved. */
  sync_subproject(id: string): Task | null {
    const c = this.db();
    const sp = db.get_task(c, id);
    if (!sp) return null;
    const st = db.subproject_status(sp, db.subproject_tasks(c, id));
    let moved: Task | null = null;
    if (st && st !== sp.status) {
      moved = db.update_task(c, id, [["status", st]]);
      if (moved) {
        this.status_changed(c, moved, sp.status);
        this.emit_task(moved);
      }
    }
    if (moved) this.task_changed(moved);
    return moved;
  }

  private status_changed(c: Conn, t: Task, old: string) {
    status_script.status_changed(this, c, t, old);
  }

  private task_changed(t: Task) {
    task_tmp.changed(this, t);
  }

  is_running(task_id: string): boolean {
    return this.runs.has(task_id);
  }

  /** App-level scratch folder for a profile. */
  profile_scratch_dir(profile_id: string): string {
    return join(this.data_dir, "profiles", profile_id, "scratch");
  }
}

/** Rust's `Shared` (an `Arc<AppState>`). */
export type Shared = AppState;

/** `bin/huntaway`, which runs this server (and its subcommands, such as `mcp`). */
export function default_exe(): string {
  return process.env.IA_TS_EXE || new URL("../bin/huntaway", import.meta.url).pathname;
}

/**
 * The preview URL task `id` gets with `fields`' change to its pull request (see Rust's state.rs). `undefined` when it
 * doesn't change.
 */
function preview_following_pr(c: Conn, id: string, fields: Array<[string, any]>): string | null | undefined {
  const pr = fields.find(([k]) => k === "pr_url");
  if (!pr) return undefined;
  if (fields.some(([k]) => k === "preview_url")) return undefined;
  const t = db.get_task(c, id);
  if (!t) return undefined;
  const p = t.project_id ? db.get_project(c, t.project_id) : null;
  if (!p) return undefined;
  if (p.pr_preview_url == null || (t.preview_url != null && t.preview_url !== db.preview_for(p, t.pr_url ?? null))) return undefined;
  const preview = db.preview_for(p, typeof pr[1] === "string" ? pr[1] : null);
  return preview !== (t.preview_url ?? null) ? preview : undefined;
}
