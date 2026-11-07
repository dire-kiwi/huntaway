// Port of server/src/db/tests.rs.
import { afterAll, test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../db.ts";
import type { Conn } from "../db.ts";
import { path_str } from "../util.ts";
import * as history from "../threads/history.ts";
import {
  PAGE_BYTES,
  PrChecks_default,
  Queued_new,
  Reviewer_default,
  SCRATCH,
  VERSION,
  add_cost,
  api_env,
  available_configs,
  check_dependencies,
  check_resolution,
  clear_queued,
  clone_dir_or_default,
  default_clone_dir,
  delete_claude_config,
  drop_dependency,
  ensure_profile,
  get_claude_config,
  get_profile,
  get_project,
  get_task,
  idle_sessions,
  insert_claude_config,
  insert_message,
  insert_profile,
  insert_project,
  insert_run,
  insert_scratch_task,
  insert_task,
  is_scratch,
  list_claude_configs,
  list_messages,
  list_profiles,
  message_page,
  migrate_claude_configs,
  open,
  preview_for,
  proxy,
  queue,
  scratch_task_by_number,
  set_run_config_dir,
  set_run_session,
  set_setting,
  subagent_messages,
  subproject_status,
  summarizers_for,
  take_queued,
  task_claude_config,
  task_config_dir,
  unmet_dependencies,
  update_claude_config,
  update_profile,
  update_project,
  update_task,
  type Message,
  type NewProject,
  type NewTask,
  type Project,
  type Task,
  type UserReplies,
} from "../db.ts";

// testing.ts's temp_dir, without importing testing.ts: it brings in AppState and with it every module, and the db tests
// only need the database.
// (`after` at the top level, as one called inside a test runs when that test ends.)
let root: string | null = null;
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
function temp_dir(): string {
  root ??= mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ia-ts-db-test-"));
  return mkdtempSync(join(root, "t-"));
}

const user_version = (c: Conn) => Number(db.value(c, "PRAGMA user_version"));
const has_column = (c: Conn, table: string, column: string) => !!db.value(c, "SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name=?2", table, column);
/** `a..=b` */
const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);
const db_path = () => join(temp_dir(), "huntaway.db");
/** Open a database at `path` (made at the latest version), run `sql` on it, and close it. */
function prepare_at(path: string, sql: string | ((c: Conn) => void)) {
  const c = open(path);
  if (typeof sql === "string") c.exec(sql);
  else sql(c);
  c.close();
}

test("commits_dont_sync_to_disk_one_by_one", () => {
  const c = open(db_path());
  assert.equal(db.value(c, "PRAGMA journal_mode"), "wal");
  // NORMAL
  assert.equal(db.value(c, "PRAGMA synchronous"), 1);
  c.close();
});

const np = (profile_id: string, id = "pr", key = "X"): NewProject => ({
  id,
  profile_id,
  name: id === "pr" ? "x" : id,
  key,
  repo_path: "/x",
  scratch_path: "/s",
  worktrees_root: "/w",
  base_branch: null,
  use_worktrees: false,
});
const nt = (profile_id: string, o: Partial<NewTask> = {}): NewTask => ({
  profile_id,
  project_id: null,
  kind: "task",
  title: "t",
  description: "",
  status: "todo",
  use_worktree: false,
  model: null,
  effort: null,
  claude_config_id: null,
  ...o,
});

// HA-37: a failed insert used up its project's next key number.
test("a_task_that_cant_be_added_doesnt_use_up_a_number", () => {
  const c = open(":memory:");
  const p = insert_profile(c, "me", [], null);
  insert_project(c, np(p.id));
  const t = (profile_id: string) => nt(profile_id, { project_id: "pr" });
  assert.throws(() => insert_task(c, t("nobody")));
  assert.equal(insert_task(c, t(p.id)).number, 1);
  // Within a transaction too.
  c.exec("BEGIN");
  assert.throws(() => insert_task(c, t("nobody")));
  assert.equal(insert_task(c, t(p.id)).number, 2);
  c.exec("COMMIT");
  assert.equal(insert_task(c, t(p.id)).number, 3);
});

/** A database whose COMMITs fail while `fk_child` has a row with no parent (a deferred foreign key). */
function deferred_fk(): Conn {
  const c = open(":memory:");
  c.exec("CREATE TABLE fk_parent (id TEXT PRIMARY KEY); CREATE TABLE fk_child (parent TEXT REFERENCES fk_parent(id) DEFERRABLE INITIALLY DEFERRED);");
  return c;
}

// HA-262: a COMMIT that failed counted tx's depth down twice, so its ROLLBACK threw instead (hiding the error and leaving
// the transaction open) and every later tx ran `SAVEPOINT sp-1`.
test("a_transaction_whose_commit_fails_is_rolled_back_and_the_next_one_works", () => {
  const c = deferred_fk();
  assert.throws(() => db.tx(c, () => db.run(c, "INSERT INTO fk_child VALUES ('nobody')")), /FOREIGN KEY constraint failed/);
  assert.equal(c.isTransaction, false);
  assert.equal(db.value(c, "SELECT COUNT(*) FROM fk_child"), 0);
  assert.equal(
    db.tx(c, () => db.tx(c, () => db.run(c, "INSERT INTO fk_parent VALUES ('p')").changes)),
    1,
  );
  assert.equal(c.isTransaction, false);
  assert.equal(db.value(c, "SELECT COUNT(*) FROM fk_parent"), 1);
});

// HA-262: insert_task's RELEASE (its COMMIT, outside a transaction) that failed left the transaction open.
test("an_insert_task_whose_commit_fails_is_rolled_back", () => {
  const c = deferred_fk();
  const p = insert_profile(c, "me", [], null);
  insert_project(c, np(p.id));
  c.exec("CREATE TRIGGER orphan AFTER INSERT ON tasks BEGIN INSERT INTO fk_child VALUES ('nobody'); END;");
  assert.throws(() => insert_task(c, nt(p.id, { project_id: "pr" })), /FOREIGN KEY constraint failed/);
  assert.equal(c.isTransaction, false);
  c.exec("DROP TRIGGER orphan");
  assert.equal(insert_task(c, nt(p.id, { project_id: "pr" })).number, 1);
});

test("ensure_profile_makes_a_profile_only_if_none_has_its_name", () => {
  const c = open(":memory:");
  const p = ensure_profile(c, "personal", "/claude/personal");
  assert.ok(p, "made");
  assert.equal(p.name, "personal");
  const configs = list_claude_configs(c);
  assert.equal(configs.length, 1);
  assert.deepEqual([configs[0].name, configs[0].config_dir], ["personal", "/claude/personal"]);
  assert.deepEqual(p.claude_config_ids, [configs[0].id]);
  // On the next start, or with the name in another case, it's left as it is.
  assert.equal(ensure_profile(c, "personal", "/claude/personal"), null);
  assert.equal(ensure_profile(c, "Personal", "/elsewhere"), null);
  assert.equal(list_profiles(c).length, 1);
  assert.equal(list_claude_configs(c).length, 1);
  // A config with the directory already is shared, as when a profile is made with claude_config_dir.
  const work = ensure_profile(c, "work", "/claude/personal");
  assert.ok(work, "made");
  assert.deepEqual(work.claude_config_ids, p.claude_config_ids);
});

test("archived_projects_threads_arent_compacted", () => {
  const c = open(":memory:");
  const p = insert_profile(c, "me", [], null);
  insert_project(c, np(p.id));
  const t = insert_task(c, nt(p.id, { project_id: "pr", status: "in_review" }));
  // Its last prompt ended 55 minutes ago, and nothing has happened since.
  db.run(c, "UPDATE tasks SET session_id='s', last_activity_at='2026-01-01T10:05:00Z' WHERE id=?1", t.id);
  const r = insert_run(c, t.id, "prompt");
  db.run(c, "UPDATE runs SET status='exited', ended_at='2026-01-01T10:05:00Z' WHERE id=?1", r.id);
  const idle = (c: Conn) => idle_sessions(c, "2026-01-01T10:10:00Z", "2026-01-01T09:00:00Z");
  assert.deepEqual(idle(c), [t.id]);
  update_project(c, "pr", [["archived_at", "2026-01-01T10:06:00Z"]]);
  assert.deepEqual(idle(c), []);
  update_project(c, "pr", [["archived_at", null]]);
  assert.deepEqual(idle(c), [t.id]);
});

function thread(c: Conn): string {
  const p = insert_profile(c, "me", [], null);
  return insert_task(c, nt(p.id, { kind: "scratch" })).id;
}

test("user_replies_are_the_users_own_messages_after_what_the_agent_said", () => {
  const c = open(":memory:");
  const t = thread(c);
  const said = (text: string) => ({
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: "hm" },
        { type: "text", text },
      ],
    },
  });
  insert_message(c, t, "user", { text: "Start working on this task.", auto: true, start: true });
  insert_message(c, t, "user", { text: "Also do the docs" });
  insert_message(c, t, "claude", said("Working on it."));
  insert_message(c, t, "claude", { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } });
  insert_message(c, t, "claude", said("Should it be A or B?"));
  insert_message(c, t, "event", { level: "info", text: "Needs attention" });
  insert_message(c, t, "user", { text: " A is fine, B is too slow \n", steered: true });
  insert_message(c, t, "user", { text: "and keep the old flag" });
  insert_message(c, t, "claude", said("Done."));
  insert_message(c, t, "user", { text: "Fix this from IA-2", from_agent: true });
  insert_message(c, t, "user", { text: "Serious issues found in your changes", auto: true });
  const everything: UserReplies["replies"] = [
    [null, "Also do the docs"],
    ["Should it be A or B?", "A is fine, B is too slow"],
    [null, "and keep the old flag"],
  ];
  const done = "Done.";
  assert.deepEqual(history.user_replies(c, t, null), { replies: everything, since: done, earlier: 0 });
  // Only the latest, with how many are left out.
  for (let n = 0; n <= 4; n++) {
    const skip = Math.max(0, 3 - n);
    assert.deepEqual(history.user_replies(c, t, n), { replies: everything.slice(skip), since: done, earlier: skip }, `limit ${n}`);
  }
  insert_message(c, t, "user", { text: "Ship it" });
  assert.deepEqual(history.user_replies(c, t, 1), { replies: [[done, "Ship it"]], since: null, earlier: 3 });
});

test("user_replies_read_a_long_thread_only_back_to_the_latest", () => {
  const c = open(":memory:");
  const t = thread(c);
  const said = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
  for (let i = 0; i < 50; i++) {
    insert_message(c, t, "claude", said(`Question ${i}?`));
    insert_message(c, t, "user", { text: `Answer ${i}` });
    insert_message(c, t, "claude", { type: "user", message: { content: [{ type: "tool_result", content: "x".repeat(1000) }] } });
  }
  const all = history.user_replies(c, t, null);
  assert.deepEqual([all.replies.length, all.since, all.earlier], [50, null, 0]);
  const r = history.user_replies(c, t, 30);
  assert.deepEqual(r.replies, all.replies.slice(20));
  assert.deepEqual([r.since, r.earlier], [null, 20]);
  assert.deepEqual(r.replies[0], ["Question 20?", "Answer 20"]);
});

test("queued_messages_remember_whether_an_agent_sent_them", () => {
  const c = open(":memory:");
  const id = thread(c);
  assert.equal(take_queued(c, id), null);
  const taken = (c: Conn) => {
    const q = take_queued(c, id);
    return q && [q.text, q.from_agent, q.user_text];
  };

  // From another agent, and it stays that way through the queue.
  queue(c, id, Queued_new("rebase please", true));
  queue(c, id, Queued_new("and run the tests", true));
  assert.deepEqual(taken(c), ["rebase please\n\nand run the tests", true, null]);
  assert.equal(taken(c), null);

  // Anything the user adds makes it the user's, whichever came first, and their parts are kept apart.
  queue(c, id, Queued_new("from an agent", true));
  queue(c, id, Queued_new("from me", false));
  assert.equal(get_task(c, id)!.queued_user_text, "from me");
  assert.deepEqual(taken(c), ["from an agent\n\nfrom me", false, "from me"]);
  queue(c, id, Queued_new("from me", false));
  queue(c, id, Queued_new("from an agent", true));
  queue(c, id, Queued_new("and me", false));
  assert.deepEqual(taken(c), ["from me\n\nfrom an agent\n\nand me", false, "from me\n\nand me"]);

  // Clearing the queue forgets where it came from.
  queue(c, id, Queued_new("dropped", true));
  const t = clear_queued(c, id)!;
  assert.deepEqual([t.queued_message, t.queued_user_text], [null, null]);
  queue(c, id, Queued_new("mine", false));
  assert.deepEqual(taken(c), ["mine", false, "mine"]);
});

test("a_users_message_sent_with_other_agents_counts_only_their_part", () => {
  const c = open(":memory:");
  const t = thread(c);
  insert_message(c, t, "user", { text: "Build a payment gateway\n\nAdd a search cache", user_text: "Add a search cache" });
  insert_message(c, t, "claude", { type: "assistant", message: { content: [{ type: "text", text: "A or B?" }] } });
  const r = history.user_replies(c, t, null);
  assert.deepEqual([r.replies, r.since], [[[null, "Add a search cache"]], "A or B?"]);
});

test("subprojects_follow_their_tasks_by_priority", () => {
  const c = open(":memory:");
  const id = thread(c);
  const t = get_task(c, id)!;
  const sp: Task = { ...t, kind: "task", subproject: true, status: "in_progress" };
  const task = (status: string): Task => ({ ...sp, status, parent_id: sp.id, subproject: false });
  const tasks = (sts: string[]) => sts.map(task);

  // Nothing started yet: it stays put.
  assert.equal(subproject_status(sp, []), null);
  assert.equal(subproject_status(sp, tasks(["todo", "backlog"])), null);
  // Needs attention beats in progress, which beats in review.
  assert.equal(subproject_status(sp, tasks(["in_review", "in_progress", "needs_attention", "todo"])), "needs_attention");
  assert.equal(subproject_status(sp, tasks(["in_review", "in_progress", "done"])), "in_progress");
  assert.equal(subproject_status(sp, tasks(["in_review", "ready_for_merge", "done", "todo"])), "in_review");
  // Still in review once everything's merged.
  assert.equal(subproject_status(sp, tasks(["done", "done"])), "in_review");

  // Its own agent counts too.
  const busy = { ...sp, running: true };
  assert.equal(subproject_status(busy, tasks(["done"])), "in_progress");
  const asking = { ...sp, attention_reason: "Approve Bash?" };
  assert.equal(subproject_status(asking, tasks(["in_progress"])), "needs_attention");

  // Merging it or marking it done is left to the user.
  const merging = { ...sp, merging: true, status: "ready_for_merge" };
  assert.equal(subproject_status(merging, tasks(["in_progress"])), null);
  const done = { ...sp, status: "done" };
  assert.equal(subproject_status(done, tasks(["in_progress"])), null);
  // Its scratch tasks aren't part of its work, so they don't count.
  const scratch = (status: string): Task => ({ ...task(status), task_type: SCRATCH });
  assert.equal(subproject_status(sp, [scratch("needs_attention"), scratch("in_progress"), task("todo")]), null);
  assert.equal(subproject_status(sp, [scratch("needs_attention"), task("in_review")]), "in_review");
  // Only subprojects follow their tasks.
  const plain = { ...sp, subproject: false };
  assert.equal(subproject_status(plain, tasks(["in_progress"])), null);
});

test("done_tasks_and_only_done_tasks_have_a_resolution", () => {
  const c = open(":memory:");
  const id = thread(c);
  const set = (fields: Array<[string, any]>) => update_task(c, id, fields)!.resolution;
  assert.equal(get_task(c, id)!.resolution, null);

  // Done without saying how means done.
  assert.equal(set([["status", "done"]]), "done");
  // A done task's resolution can change, and stays put through other updates.
  assert.equal(set([["resolution", "wont_fix"]]), "wont_fix");
  assert.equal(
    set([
      ["status", "done"],
      ["title", "x"],
    ]),
    "wont_fix",
  );
  // Clearing it falls back to done.
  assert.equal(set([["resolution", null]]), "done");
  // Out of done clears it, whatever it was.
  set([["resolution", "not_done"]]);
  assert.equal(set([["status", "todo"]]), null);
  assert.equal(
    set([
      ["status", "done"],
      ["resolution", "not_done"],
    ]),
    "not_done",
  );

  // Created done, it's done.
  const t = get_task(c, id)!;
  const created = insert_task(c, nt(t.profile_id, { kind: "scratch", status: "done" }));
  assert.equal(created.resolution, "done");
});

test("done_tasks_keep_when_they_were_done", () => {
  const c = open(":memory:");
  const id = thread(c);
  const set = (fields: Array<[string, any]>) => update_task(c, id, fields)!.done_at;
  assert.equal(get_task(c, id)!.done_at, null);

  const done = set([["status", "done"]]);
  assert.ok(done, "moving it into done sets the time");
  // Staying done keeps the time it was done, through other updates and a new resolution.
  update_task(c, id, [["done_at", "2026-01-01T00:00:00Z"]]);
  assert.equal(
    set([
      ["status", "done"],
      ["title", "x"],
    ]),
    "2026-01-01T00:00:00Z",
  );
  assert.equal(set([["resolution", "wont_fix"]]), "2026-01-01T00:00:00Z");
  // Out of done clears it, and done again starts over.
  assert.equal(set([["status", "in_review"]]), null);
  const again = set([["status", "done"]]);
  assert.ok(again != null && again >= done);

  // Created done, it's done from then.
  const t = get_task(c, id)!;
  const created = insert_task(c, nt(t.profile_id, { status: "done" }));
  assert.ok(created.done_at != null && created.done_at >= created.created_at);
});

test("resolutions_are_checked_against_the_status", () => {
  assert.doesNotThrow(() => check_resolution("done", "wont_fix"));
  assert.doesNotThrow(() => check_resolution("todo", null));
  assert.throws(() => check_resolution("done", "maybe"));
  assert.throws(() => check_resolution("done", 1));
  assert.throws(() => check_resolution("in_review", "done"));
});

test("a_database_from_version_58_has_its_plan_artifact_and_diagram_tasks_labelled", () => {
  const path = db_path();
  prepare_at(
    path,
    `DROP INDEX documents_task;
                 ALTER TABLE documents DROP COLUMN label;
                 CREATE UNIQUE INDEX documents_task ON documents(task_id, version);
                 ALTER TABLE tasks DROP COLUMN labels;
                 PRAGMA user_version=58;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,task_type,work_dir,number,title,status,last_activity_at,created_at,updated_at)
                   VALUES ('plan','p','task','plan',NULL,1,'Plan','in_review','1','1','1'),
                          ('art','p','task','artifact',NULL,2,'Page','todo','1','1','1'),
                          ('chat','p','task','scratch','/chat',1,'Chat','done','1','1','1'),
                          ('code','p','task',NULL,NULL,3,'Code','todo','1','1','1');
                 INSERT INTO documents (task_id,version,content,open,created_at,updated_at)
                   VALUES ('plan',1,'<h1>1</h1>',0,'1','1'), ('plan',2,'<h1>2</h1>',0,'1','1'), ('art',1,'<p>',0,'1','1');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  const task = (id: string) => get_task(c, id)!;
  const [plan, art, chat, code] = [task("plan"), task("art"), task("chat"), task("code")];
  assert.deepEqual([plan.task_type, plan.labels, plan.work_dir], [null, ["plan"], "documents/plan"]);
  assert.deepEqual([art.task_type, art.labels, art.work_dir], [null, ["artifact"], "documents/art"]);
  assert.deepEqual([chat.task_type, chat.labels.length, chat.work_dir], [SCRATCH, 0, "/chat"]);
  assert.deepEqual([code.task_type, code.labels.length, code.work_dir], [null, 0, null]);
  const docs = db.all(c, "SELECT task_id, label, version FROM documents ORDER BY task_id, version").map((r) => [r.task_id, r.label, r.version]);
  assert.deepEqual(docs, [
    ["art", "artifact", 1],
    ["plan", "plan", 1],
    ["plan", "plan", 2],
  ]);
  // Another label's version 1 can sit beside the plan's.
  db.run(c, "INSERT INTO documents (task_id,label,version,content,created_at,updated_at) VALUES ('plan','diagram',1,'x','1','1')");
  c.close();
});

test("a_database_that_had_start_from_as_an_earlier_version_gets_the_columns_it_skipped", () => {
  // Builds of start_from had it as version 65 (skipping that version's limit columns), then 71 (skipping
  // restart_window), then 73 (skipping the runs' sessions), then 74 (skipping pr_checks), then 75 (skipping
  // require_pr_approval); the first two had no merge_approval (72) either, and none before 74 had pr_checks.
  const skipped: Array<[number, string]> = [
    [
      65,
      "ALTER TABLE tasks DROP COLUMN limit_reset_at; ALTER TABLE profiles DROP COLUMN limit_wait; ALTER TABLE profiles DROP COLUMN limit_switch; ALTER TABLE profiles DROP COLUMN merge_approval;",
    ],
    [71, "ALTER TABLE claude_configs DROP COLUMN restart_window; ALTER TABLE profiles DROP COLUMN merge_approval;"],
    [73, "ALTER TABLE runs DROP COLUMN session_id; ALTER TABLE runs DROP COLUMN session_cost; ALTER TABLE tasks DROP COLUMN pr_checks;"],
    [74, "ALTER TABLE tasks DROP COLUMN pr_checks;"],
    [75, "ALTER TABLE profiles DROP COLUMN require_pr_approval; ALTER TABLE projects DROP COLUMN require_pr_approval;"],
  ];
  for (const [version, dropped] of skipped) {
    const path = db_path();
    prepare_at(path, `${dropped} PRAGMA user_version=${version};`);
    const c = open(path);
    assert.equal(user_version(c), VERSION);
    const columns = [
      ["tasks", "start_from"],
      ["tasks", "limit_reset_at"],
      ["profiles", "limit_wait"],
      ["profiles", "limit_switch"],
      ["claude_configs", "restart_window"],
      ["profiles", "merge_approval"],
      ["runs", "session_id"],
      ["runs", "session_cost"],
      ["tasks", "pr_checks"],
      ["profiles", "require_pr_approval"],
      ["projects", "require_pr_approval"],
    ];
    for (const [table, column] of columns) assert.ok(has_column(c, table, column), `version ${version}: ${table}.${column}`);
    c.close();
  }
});

test("a_database_from_version_85_gets_review_thread_skills", () => {
  const path = db_path();
  prepare_at(path, "DROP TABLE review_thread_skills; PRAGMA user_version=85;");
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  assert.ok(Number(db.value(c, "SELECT COUNT(*) FROM pragma_table_info('review_thread_skills')")) > 0);
  c.close();
});

test("a_database_from_version_88_gets_the_thread_tables", () => {
  const path = db_path();
  const tables = ["thread_items", "thread_requests", "thread_events", "thread_item_origins"];
  prepare_at(path, `${tables.map((t) => `DROP TABLE ${t};`).join(" ")} PRAGMA user_version=88;`);
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  for (const t of tables) assert.ok(Number(db.value(c, "SELECT COUNT(*) FROM pragma_table_info(?1)", t)) > 0, t);
  c.close();
  // Again from 87 with the tables there (another build took the version): it goes on.
  prepare_at(path, "PRAGMA user_version=88;");
  const again = open(path);
  assert.equal(user_version(again), VERSION);
  again.close();
});

test("a_database_from_version_94_gets_threads_kept_as_items", () => {
  const path = db_path();
  // A task from before, with a message: it isn't flagged.
  const c0 = open(path);
  const p = db.insert_profile(c0, "p", [], null);
  const t = db.insert_task(c0, { profile_id: p.id, project_id: null, kind: "task", title: "t", description: "", status: "todo", use_worktree: false });
  db.insert_message(c0, t.id, "user", { text: "hi" });
  c0.close();
  prepare_at(path, "DROP TABLE threads; ALTER TABLE tasks DROP COLUMN thread_items; PRAGMA user_version=94;");
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  assert.ok(Number(db.value(c, "SELECT COUNT(*) FROM pragma_table_info('threads')")) > 0);
  assert.equal(db.value(c, "SELECT thread_items FROM tasks WHERE id=?1", t.id), 0);
  c.close();
  // Again from 94 with them there (another build took the version): it goes on.
  prepare_at(path, "PRAGMA user_version=94;");
  const again = open(path);
  assert.equal(user_version(again), VERSION);
  again.close();
});

// HA-226: step 14 of docs/threads.md deletes the rows of tasks on items from before they moved.
test("a_database_from_version_101_loses_the_message_rows_of_tasks_on_items", () => {
  const path = db_path();
  const c0 = open(path);
  const p = db.insert_profile(c0, "p", [], null);
  const task = (title: string) =>
    db.insert_task(c0, { profile_id: p.id, project_id: null, kind: "task", title, description: "", status: "todo", use_worktree: false }).id;
  const moved = task("moved");
  const stays = task("on messages");
  const row = (task_id: string, at: string) =>
    db.run(c0, "INSERT INTO messages (task_id, kind, data, created_at) VALUES (?1, 'user', '{}', ?2)", task_id, at).lastInsertRowid;
  row(moved, "2026-11-01T00:00:00.000Z");
  row(moved, "2026-11-02T00:00:00.000Z");
  // Kept after it moved, as a message whose items couldn't be written is.
  const late = row(moved, "2026-11-03T00:00:01.000Z");
  const other = row(stays, "2026-11-01T00:00:00.000Z");
  for (const id of [moved, stays]) db.run(c0, "INSERT INTO threads (task_id, converter, created_at, writes) VALUES (?1, 5, ?2, 2)", id, "2026-11-01");
  db.run(c0, "UPDATE tasks SET thread_source='items', thread_items=1 WHERE id=?1", moved);
  db.run(c0, "UPDATE threads SET flipped_at='2026-11-03T00:00:00.000Z', flipped_writes=2 WHERE task_id=?1", moved);
  c0.close();
  prepare_at(path, "PRAGMA user_version=101;");
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  assert.deepEqual(
    db.all(c, "SELECT id FROM messages ORDER BY id").map((r) => r.id),
    [late, other],
  );
  assert.equal(db.value(c, "SELECT flipped_writes FROM threads WHERE task_id=?1", moved), null);
  // The ids go on from where they were (threads/source.ts's next_id).
  assert.equal(db.value(c, "SELECT seq FROM sqlite_sequence WHERE name='messages'"), other);
  c.close();
});

test("a_database_from_version_54_gets_automations", () => {
  const path = db_path();
  prepare_at(path, "DROP TABLE automation_runs; DROP TABLE automations; PRAGMA user_version=54;");
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  for (const table of ["automations", "automation_runs"]) {
    assert.ok(Number(db.value(c, "SELECT COUNT(*) FROM pragma_table_info(?1)", table)) > 0, table);
  }
  c.close();
});

test("a_database_from_version_60_gets_setup_threads", () => {
  const path = db_path();
  prepare_at(
    path,
    `ALTER TABLE projects DROP COLUMN setup_task_id;
                 PRAGMA user_version=60;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('pr','p','Web','WEB','/nowhere','/s','/w','1');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  // Master's version 60 stays (HA-15's watch_pull_requests), and projects from before have no setup thread yet.
  const p = get_project(c, "pr")!;
  assert.deepEqual([p.watch_pull_requests, p.setup_task_id], ["off", null]);
  assert.equal(update_project(c, "pr", [["setup_task_id", "t"]])!.setup_task_id, "t");
  c.close();
});

test("a_database_from_version_48_has_its_done_tasks_done_since_they_last_changed", () => {
  const path = db_path();
  prepare_at(
    path,
    `ALTER TABLE tasks DROP COLUMN done_at;
                 PRAGMA user_version=48;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,status,resolution,last_activity_at,created_at,updated_at)
                   VALUES ('d','p','task',1,'Done','done','done','1','1','2026-01-02T00:00:00Z'),
                          ('t','p','task',2,'To do','todo',NULL,'1','1','2026-01-03T00:00:00Z');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  assert.equal(get_task(c, "d")!.done_at, "2026-01-02T00:00:00Z");
  assert.equal(get_task(c, "t")!.done_at, null);
  c.close();
});

test("a_database_from_version_49_gets_profiles_cloning_into_their_own_folder", () => {
  const path = db_path();
  prepare_at(
    path,
    `ALTER TABLE profiles DROP COLUMN clone_dir;
                 PRAGMA user_version=49;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  let p = get_profile(c, "p")!;
  assert.deepEqual([p.clone_dir, clone_dir_or_default(p)], [null, "~/work"]);
  p = update_profile(c, "p", [["clone_dir", "~/src/work"]])!;
  assert.equal(clone_dir_or_default(p), "~/src/work");
  c.close();
});

test("a_database_from_version_50_gets_external_links_and_asana_tokens", () => {
  const path = db_path();
  prepare_at(
    path,
    `ALTER TABLE tasks DROP COLUMN external_links;
                 ALTER TABLE profiles DROP COLUMN asana_token;
                 ALTER TABLE profiles DROP COLUMN asana_user;
                 PRAGMA user_version=50;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,description,status,position,last_activity_at,created_at,updated_at)
                   VALUES ('t','p','task',1,'t','','todo',0,'1','1','1');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  const p = get_profile(c, "p")!;
  assert.deepEqual([p.asana_token, p.asana_user], [null, null]);
  assert.deepEqual(get_task(c, "t")!.external_links, []);
  c.close();
});

test("a_database_from_version_51_keeps_asana_on_for_its_profiles", () => {
  const path = db_path();
  prepare_at(
    path,
    `ALTER TABLE profiles DROP COLUMN asana_enabled;
                 PRAGMA user_version=51;
                 INSERT INTO profiles (id,name,created_at,asana_token,asana_user) VALUES ('p','work','1','tok','Ivy');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  let p = get_profile(c, "p")!;
  assert.ok(p.asana_enabled);
  assert.deepEqual([p.asana_token, p.asana_user], ["tok", "Ivy"]);
  p = update_profile(c, "p", [["asana_enabled", false]])!;
  assert.ok(!p.asana_enabled);
  assert.ok(insert_profile(c, "personal", [], null).asana_enabled, "new profiles use Asana");
  c.close();
});

test("a_database_from_version_56_gets_remerge", () => {
  const path = db_path();
  prepare_at(
    path,
    `ALTER TABLE tasks DROP COLUMN remerge;
                 PRAGMA user_version=56;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,description,status,position,merging,last_activity_at,created_at,updated_at)
                   VALUES ('t','p','task',1,'t','','ready_for_merge',0,1,'1','1','1');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  // A merge from before keeps holding its place in the queue as it did.
  let t = get_task(c, "t")!;
  assert.deepEqual([t.merging, t.remerge], [true, false]);
  t = update_task(c, "t", [["remerge", true]])!;
  assert.ok(t.remerge);
  c.close();
});

test("a_database_from_version_52_gets_fanout_ids", () => {
  const path = db_path();
  prepare_at(
    path,
    `ALTER TABLE tasks DROP COLUMN fanout_id;
                 PRAGMA user_version=52;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,description,status,position,last_activity_at,created_at,updated_at)
                   VALUES ('t','p','task',1,'t','','todo',0,'1','1','1');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  assert.equal(get_task(c, "t")!.fanout_id, null);
  const t = update_task(c, "t", [["fanout_id", "f1"]])!;
  assert.equal(t.fanout_id, "f1");
  c.close();
});

test("a_database_from_version_61_gets_push_subscriptions", () => {
  const path = db_path();
  prepare_at(path, "DROP TABLE push_subscriptions; PRAGMA user_version=61;");
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  db.run(c, "INSERT INTO push_subscriptions (id,endpoint,p256dh,auth,events,created_at) VALUES ('s','https://x/1','k','a','{}','1')");
  // One per endpoint.
  assert.throws(() => db.run(c, "INSERT INTO push_subscriptions (id,endpoint,p256dh,auth,events,created_at) VALUES ('t','https://x/1','k','a','{}','1')"));
  c.close();
});

// HA-137 (ported by HA-209): migration 97. (The push module's reading of such a row is in integrations/push/expo_tests.test.ts:
// the db tests don't import the push module, which brings in the rest of the server.)
test("push_subscriptions_from_before_version_97_are_web_push", () => {
  const path = db_path();
  // As a board at version 96 left it: no kind or device_id, and a browser's subscription.
  prepare_at(
    path,
    `DROP TABLE push_subscriptions;
     CREATE TABLE push_subscriptions (id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
       name TEXT NOT NULL DEFAULT '', events TEXT NOT NULL, created_at TEXT NOT NULL, last_sent_at TEXT, last_error TEXT);
     INSERT INTO push_subscriptions (id,endpoint,p256dh,auth,name,events,created_at) VALUES ('s','https://push.example.com/1','k','a','Chrome','{}','1');
     PRAGMA user_version=96;`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  assert.deepEqual(
    { ...db.one<object>(c, "SELECT kind, device_id, name FROM push_subscriptions WHERE id='s'") },
    { kind: "web", device_id: null, name: "Chrome" },
  );
  // New rows are web unless they say otherwise.
  db.run(c, "INSERT INTO push_subscriptions (id,endpoint,p256dh,auth,events,created_at) VALUES ('t','https://push.example.com/2','k','a','{}','1')");
  db.run(
    c,
    "INSERT INTO push_subscriptions (id,endpoint,p256dh,auth,events,created_at,kind,device_id) VALUES ('u','ExponentPushToken[x]','','','{}','1','expo','d')",
  );
  assert.deepEqual(
    db.all<{ kind: string }>(c, "SELECT kind FROM push_subscriptions ORDER BY id").map((r) => r.kind),
    ["web", "web", "expo"],
  );
  // Run again over the columns (as when another migration took the version first), it leaves them as they are.
  c.exec("PRAGMA user_version=96;");
  c.close();
  const again = open(path);
  assert.equal(user_version(again), VERSION);
  assert.equal(db.value(again, "SELECT kind FROM push_subscriptions WHERE id='u'"), "expo");
  again.close();
});

test("a_database_from_version_53_gets_pull_request_watches", () => {
  const path = db_path();
  prepare_at(
    path,
    `DROP TABLE pr_watches;
                 PRAGMA user_version=53;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,description,status,position,last_activity_at,created_at,updated_at)
                   VALUES ('t','p','task',1,'t','','todo',0,'1','1','1');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  db.run(c, "INSERT INTO pr_watches (task_id,pr,state,updated_at) VALUES ('t','github.com/o/r#1','{}','1')");
  // A stored wait from before it had a pull request is read as one without.
  const w = { since: "1", until: "2", call_id: "c", run_id: "r" };
  const wait = update_task(c, "t", [["agent_wait", w]])!.agent_wait!;
  assert.equal(wait.pull_request, undefined);
  assert.equal(JSON.stringify(wait), '{"reason":null,"since":"1","until":"2","tasks":[],"call_id":"c","run_id":"r"}');
  // They go with their task.
  db.run(c, "DELETE FROM tasks WHERE id='t'");
  assert.equal(db.value(c, "SELECT COUNT(*) FROM pr_watches"), 0);
  c.close();
});

test("profiles_clone_into_a_folder_named_after_them_by_default", () => {
  assert.equal(default_clone_dir("personal"), "~/personal");
  assert.equal(default_clone_dir(" a/b "), "~/a-b");
  for (const name of ["", " ", ".", ".."]) assert.equal(default_clone_dir(name), "~", JSON.stringify(name));
});

test("a_database_from_version_70_gets_restart_window_off", () => {
  const path = db_path();
  prepare_at(
    path,
    `ALTER TABLE claude_configs DROP COLUMN restart_window; PRAGMA user_version=70;
                 INSERT INTO claude_configs (id,name,config_dir,created_at,show_usage) VALUES ('c','work','~/.claude','1',1);`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  let cfg = get_claude_config(c, "c")!;
  assert.deepEqual([cfg.show_usage, cfg.restart_window], [true, false]);
  cfg = update_claude_config(c, "c", [["restart_window", true]])!;
  assert.ok(cfg.restart_window);
  c.close();
});

test("a_database_from_version_86_gets_configs_without_a_proxy", () => {
  const path = db_path();
  prepare_at(
    path,
    `ALTER TABLE claude_configs DROP COLUMN api_url; ALTER TABLE claude_configs DROP COLUMN api_key;
                 ALTER TABLE claude_configs DROP COLUMN management_key; PRAGMA user_version=86;
                 INSERT INTO claude_configs (id,name,config_dir,created_at) VALUES ('c','work','~/.claude','1');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  const cfg = get_claude_config(c, "c")!;
  assert.deepEqual([cfg.api_url, cfg.has_api_key, cfg.has_management_key], [null, false, false]);
  assert.deepEqual(api_env(cfg), []);
  c.close();
});

test("a_config_with_a_proxy_sends_claude_there", () => {
  const c = open(":memory:");
  let cfg = insert_claude_config(c, "pool", "~/.claude-personal", "claude");
  cfg = update_claude_config(c, cfg.id, [
    ["api_url", "http://10.0.0.5:8317/"],
    ["api_key", "sk-1"],
  ])!;
  assert.equal(proxy(cfg), "http://10.0.0.5:8317/");
  assert.deepEqual(api_env(cfg), [
    ["ANTHROPIC_BASE_URL", "http://10.0.0.5:8317"],
    ["ANTHROPIC_AUTH_TOKEN", "sk-1"],
    ["ANTHROPIC_API_KEY", ""],
  ]);
  // The keys stay on the host.
  const v = JSON.parse(JSON.stringify(cfg));
  assert.deepEqual([v.api_key, v.management_key, v.has_api_key, v.has_management_key], [undefined, undefined, true, false]);
  // Codex doesn't go through it.
  const codex = update_claude_config(c, cfg.id, [["agent", "codex"]])!;
  assert.deepEqual([proxy(codex), api_env(codex).length], [null, 0]);
});

test("a_database_from_version_80_gets_call_ids_shared_by_each_calls_rows", () => {
  const path = db_path();
  prepare_at(
    path,
    `ALTER TABLE call_usage DROP COLUMN call_id; PRAGMA user_version=80;
             INSERT INTO call_usage (at, purpose, task_id, config_id, model, runtime) VALUES
               ('1', 'window', NULL, 'c', 'opus', 'claude'), ('1', 'window', NULL, 'c', 'haiku', 'claude'),
               ('1', 'window', NULL, 'd', 'haiku', 'claude'), ('2', 'window', NULL, 'c', 'haiku', 'claude'), ('1', 'title', NULL, 'c', 'haiku', 'claude');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  const ids: string[] = db.all(c, "SELECT call_id FROM call_usage ORDER BY id").map((r) => r.call_id);
  assert.equal(ids[0], ids[1]);
  assert.equal(new Set(ids).size, 4, JSON.stringify(ids));
  c.close();
});

test("a_database_from_version_81_gets_its_reviews_the_efforts_of_their_tasks", () => {
  const path = db_path();
  let own = "";
  let def = "";
  prepare_at(path, (c) => {
    const p = insert_profile(c, "p", [], null);
    const [a, b] = [insert_task(c, nt(p.id, { status: "in_review" })), insert_task(c, nt(p.id, { status: "in_review" }))];
    db.run(c, "UPDATE tasks SET effort='high' WHERE id=?1", a.id);
    set_setting(c, "default_effort", "low");
    c.exec("ALTER TABLE review_stats DROP COLUMN effort; PRAGMA user_version=81;");
    for (const t of [a, b]) db.run(c, "INSERT INTO review_stats (task_id, thread_id, round, at, verdict) VALUES (?1, 'r', '1', '1', 'pass')", t.id);
    [own, def] = [a.id, b.id];
  });
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  const effort = (id: string) => db.value(c, "SELECT effort FROM review_stats WHERE task_id=?1", id);
  // Its own, or the host's default.
  assert.deepEqual([effort(own), effort(def)], ["high", "low"]);
  c.close();
});

test("a_database_at_version_73_gets_tasks_pr_checks", () => {
  const path = db_path();
  let id = "";
  prepare_at(path, (c) => {
    const p = insert_profile(c, "p", [], null);
    id = insert_task(c, nt(p.id, { status: "in_review" })).id;
    c.exec("ALTER TABLE tasks DROP COLUMN pr_checks; PRAGMA user_version=73;");
  });
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  assert.equal(get_task(c, id)!.pr_checks, null);
  const checks = { ...PrChecks_default(), url: "https://github.com/o/r/pull/1", head: "a1", outcome: "failed", since: "1" };
  const t = update_task(c, id, [["pr_checks", checks]])!;
  assert.deepEqual(t.pr_checks, checks);
  c.close();
});

test("a_database_from_version_47_gets_show_usage_off", () => {
  const path = db_path();
  prepare_at(
    path,
    `ALTER TABLE claude_configs DROP COLUMN show_usage; ALTER TABLE tasks DROP COLUMN done_at;
                 PRAGMA user_version=47;
                 INSERT INTO claude_configs (id,name,config_dir,created_at) VALUES ('c','personal','~/.claude-personal','1');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  assert.deepEqual(
    list_claude_configs(c).map((c) => [c.id, c.show_usage]),
    [["c", false]],
  );
  c.close();
});

test("a_database_at_version_59_gets_projects_watch_pull_requests", () => {
  // As master's build left it, with labels (59) and no watch_pull_requests yet.
  const path = db_path();
  prepare_at(
    path,
    `ALTER TABLE projects DROP COLUMN watch_pull_requests;
                 PRAGMA user_version=59;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','p','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('pr','p','P','P','/x','/s','/w','1');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  const p = get_project(c, "pr")!;
  assert.deepEqual([p.watch_pull_requests, p.done_when_merged], ["off", true]);
  c.close();
});

test("a_database_at_version_66_gets_the_summary_columns", () => {
  // As master's build left it, with copy_files and link_folders (66) and no summaries yet.
  const path = db_path();
  prepare_at(
    path,
    `ALTER TABLE projects DROP COLUMN auto_summary;
                 ALTER TABLE projects DROP COLUMN summarizer;
                 ALTER TABLE tasks DROP COLUMN summary;
                 PRAGMA user_version=66;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','p','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('pr','p','P','P','/x','/s','/w','1');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  const p = get_project(c, "pr")!;
  assert.ok(p.auto_summary);
  assert.equal(p.summarizer, null);
  const t = insert_task(c, nt("p", { project_id: "pr" }));
  assert.equal(t.summary, null);
  c.close();
});

test("a_database_at_version_83_keeps_its_summarizer_as_the_only_one", () => {
  // As master's build left it (83), with a project and a profile each with a summarizer and no list of them yet.
  const path = db_path();
  prepare_at(
    path,
    `ALTER TABLE projects DROP COLUMN summarizers;
                 ALTER TABLE profiles DROP COLUMN summarizers;
                 PRAGMA user_version=83;
                 INSERT INTO profiles (id,name,created_at,summarizer) VALUES ('p','p','1','{"model":"haiku"}');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at,summarizer)
                   VALUES ('pr','p','P','P','/x','/s','/w','1','{"model":"sonnet"}');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  const p = get_project(c, "pr")!;
  assert.deepEqual(
    p.summarizers.map((r) => r.model),
    ["sonnet"],
  );
  assert.equal(get_profile(c, "p")!.summarizers.length, 1);
  assert.equal(summarizers_for(c, p).length, 1);
  c.close();
});

test("a_database_at_version_67_gets_projects_pull_request_settings", () => {
  // As master's build left it, with summaries (67) and no pull request settings yet: its projects keep opening them.
  const path = db_path();
  prepare_at(
    path,
    `ALTER TABLE projects DROP COLUMN pull_requests;
                 ALTER TABLE projects DROP COLUMN subproject_pull_requests;
                 PRAGMA user_version=67;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','p','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('pr','p','P','P','/x','/s','/w','1');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  let p = get_project(c, "pr")!;
  assert.ok(p.pull_requests && p.subproject_pull_requests);
  p = update_project(c, "pr", [["pull_requests", false]])!;
  assert.ok(!p.pull_requests && p.subproject_pull_requests);
  c.close();
});

test("a_database_at_version_76_has_every_task_in_later", () => {
  // As master's build left it, with a worktree start point (76) and no now/later split yet.
  const path = db_path();
  prepare_at(
    path,
    `ALTER TABLE tasks DROP COLUMN now_at;
                 PRAGMA user_version=76;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','p','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,status,last_activity_at,created_at,updated_at)
                   VALUES ('t','p','task',1,'t','todo','1','1','1');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  assert.equal(get_task(c, "t")!.now_at, null);
  const t = update_task(c, "t", [["now_at", "2030-01-01T00:00:00.000Z"]])!;
  assert.equal(t.now_at, "2030-01-01T00:00:00.000Z");
  c.close();
});

test("a_database_that_had_token_usage_as_an_earlier_version_gets_the_columns_it_skipped", () => {
  // Builds of token_usage had it as version 74, then 75, then 76, then 78, so a database that ran them skipped master's
  // 74, 75 and 76 (pr_checks, require_pr_approval, start_from), and 77 (now_at) ran as master's. The builds that had it
  // as 78 didn't add those back (but start_from), nor the runs' usage_tail at first.
  for (const version of [76, 77, 78]) {
    const path = db_path();
    prepare_at(
      path,
      `ALTER TABLE tasks DROP COLUMN pr_checks; ALTER TABLE tasks DROP COLUMN start_from;
                 ALTER TABLE profiles DROP COLUMN require_pr_approval; ALTER TABLE projects DROP COLUMN require_pr_approval;
                 ALTER TABLE runs DROP COLUMN usage_tail;
                 PRAGMA user_version=${version};`,
    );
    const c = open(path);
    assert.equal(user_version(c), VERSION);
    const cols = [
      ["tasks", "pr_checks"],
      ["tasks", "start_from"],
      ["profiles", "require_pr_approval"],
      ["projects", "require_pr_approval"],
      ["runs", "usage_tail"],
    ];
    for (const [table, column] of cols) assert.ok(has_column(c, table, column), `version ${version}: ${table}.${column}`);
    // The demo seed, which is what failed on such a database.
    const p = insert_profile(c, "p", [], null);
    assert.ok(!get_profile(c, p.id)!.require_pr_approval);
    c.close();
  }
});

test("a_database_at_version_69_gets_profiles_reviewers_and_summarizer", () => {
  // As master's build left it, with context stats (69) and no profile reviewers yet.
  const path = db_path();
  prepare_at(
    path,
    `ALTER TABLE profiles DROP COLUMN reviewers;
                 ALTER TABLE profiles DROP COLUMN summarizer;
                 PRAGMA user_version=69;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','p','1');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  let p = get_profile(c, "p")!;
  assert.deepEqual([p.reviewers, p.summarizer], [[], null]);
  const haiku = { ...Reviewer_default(), model: "haiku" };
  p = update_profile(c, "p", [["summarizer", JSON.stringify(haiku)]])!;
  assert.deepEqual(p.summarizer, haiku);
  c.close();
});

test("a_database_at_version_62_gets_projects_pr_preview_url", () => {
  // As master's build left it, with push_subscriptions (62) and no pr_preview_url yet.
  const path = db_path();
  prepare_at(
    path,
    `ALTER TABLE projects DROP COLUMN pr_preview_url;
                 PRAGMA user_version=62;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','p','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('pr','p','P','P','/x','/s','/w','1');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  const p: Project = get_project(c, "pr")!;
  assert.equal(p.pr_preview_url, null);
  assert.equal(preview_for(p, "https://github.com/o/r/pull/3"), null);
  p.pr_preview_url = "https://pr{pr}.example.com/";
  assert.equal(preview_for(p, "https://github.com/o/r/pull/3/files"), "https://pr3.example.com/");
  assert.equal(preview_for(p, "https://example.com/o/r/issues/3"), null);
  assert.equal(preview_for(p, null), null);
  c.close();
});

test("a_database_at_version_65_gets_projects_copy_files_and_link_folders", () => {
  const path = db_path();
  prepare_at(
    path,
    `ALTER TABLE projects DROP COLUMN copy_files;
                 ALTER TABLE projects DROP COLUMN link_folders;
                 PRAGMA user_version=65;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','p','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('pr','p','P','P','/x','/s','/w','1');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  let p = get_project(c, "pr")!;
  assert.deepEqual([p.copy_files, p.link_folders], ["", ""]);
  p = update_project(c, "pr", [
    ["copy_files", ".env"],
    ["link_folders", "models"],
  ])!;
  assert.deepEqual([p.copy_files, p.link_folders], [".env", "models"]);
  c.close();
});

test("a_database_where_github_accounts_were_version_42_44_or_45_keeps_them", () => {
  // As PR previews of GitHub accounts left it: at 42, before archived projects and scratch tasks took versions 42 and
  // 43, at 44, before starred tasks took 44, and at 45, before pinned titles and queued users' text took 45 and 46.
  const newer =
    "ALTER TABLE tasks DROP COLUMN title_pinned; ALTER TABLE tasks DROP COLUMN queued_user_text; ALTER TABLE claude_configs DROP COLUMN show_usage; ALTER TABLE tasks DROP COLUMN done_at;";
  const cases: Array<[number, string]> = [
    [42, `ALTER TABLE projects DROP COLUMN archived_at; ALTER TABLE tasks DROP COLUMN work_dir; ${newer}`],
    [44, `ALTER TABLE tasks DROP COLUMN starred; ALTER TABLE tasks DROP COLUMN remind_at; ALTER TABLE tasks DROP COLUMN reminder; ${newer}`],
    [45, newer],
  ];
  for (const [version, before] of cases) {
    const path = db_path();
    prepare_at(
      path,
      `${before}
                     PRAGMA user_version=${version};
                     INSERT INTO profiles (id,name,created_at,github_account) VALUES ('p','work','1','work-me');
                     INSERT INTO tasks (id,profile_id,kind,title,last_activity_at,created_at,updated_at) VALUES ('t','p','task','t','1','1','1');`,
    );
    const c = open(path);
    assert.equal(user_version(c), VERSION);
    assert.equal(get_profile(c, "p")!.github_account, "work-me", String(version));
    const t = get_task(c, "t")!;
    assert.ok(!t.starred && !t.title_pinned && t.queued_user_text == null, String(version));
    c.close();
  }
});

test("version_69_collects_the_compactions_threads_show", () => {
  const path = db_path();
  const boundary = (trigger: string, extra: string) =>
    `{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"${trigger}","pre_tokens":900,"post_tokens":90,"duration_ms":5}${extra}}`;
  const [auto, idle, user, sub] = [boundary("auto", ""), boundary("manual", ""), boundary("manual", ""), boundary("auto", ',"parent_tool_use_id":"agent-1"')];
  prepare_at(
    path,
    `DROP TABLE context_stats;
                 ALTER TABLE runs DROP COLUMN turn_start_tokens; ALTER TABLE runs DROP COLUMN turn_tokens;
                 PRAGMA user_version=68;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,status,last_activity_at,created_at,updated_at)
                   VALUES ('t','p','task',1,'One','in_progress','1','1','1');
                 INSERT INTO runs (id,task_id,kind,status,created_at) VALUES
                   ('prompt','t','prompt','done','2026-10-01T10:00:00.000Z'),
                   ('idle','t','compact','done','2026-10-01T11:00:00.000Z'),
                   ('user','t','compact','done','2026-10-01T12:00:00.000Z');
                 INSERT INTO messages (task_id,kind,data,created_at) VALUES
                   ('t','user','{"text":"go"}','2026-10-01T10:00:00.000Z'),
                   ('t','claude','${auto}','2026-10-01T10:30:00.000Z'),
                   ('t','event','{"text":"Compacting the conversation after 50 minutes idle"}','2026-10-01T11:00:00.000Z'),
                   ('t','claude','${idle}','2026-10-01T11:01:00.000Z'),
                   ('t','user','{"text":"/compact"}','2026-10-01T12:00:00.000Z'),
                   ('t','claude','${user}','2026-10-01T12:01:00.000Z'),
                   ('t','claude','${sub}','2026-10-01T12:02:00.000Z');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  const rows = db
    .all(c, "SELECT run_id, kind, source, tokens, post_tokens, duration_ms FROM context_stats ORDER BY at")
    .map((r) => [r.run_id, r.kind, r.source, r.tokens, r.post_tokens, r.duration_ms]);
  const row = (run: string, source: string) => [run, "compact", source, 900, 90, 5];
  // A subagent's compaction isn't the thread's.
  assert.deepEqual(rows, [row("prompt", "auto"), row("idle", "idle"), row("user", "user")]);
  c.close();
});

test("a_database_where_scratch_tasks_were_version_42_gets_archived_projects", () => {
  const path = db_path();
  // As a build of scratch tasks from before archived projects took version 42 left it.
  prepare_at(
    path,
    `ALTER TABLE projects DROP COLUMN archived_at;
                 ALTER TABLE tasks DROP COLUMN title_pinned;
                 ALTER TABLE tasks DROP COLUMN queued_user_text;
                 ALTER TABLE claude_configs DROP COLUMN show_usage; ALTER TABLE tasks DROP COLUMN done_at;
                 PRAGMA user_version=42;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('pr','p','Site','SP','/src/site','/s','/w','1');
                 INSERT INTO tasks (id,profile_id,kind,task_type,number,title,status,work_dir,last_activity_at,created_at,updated_at)
                   VALUES ('s','p','task','scratch',1,'Chat','done','/old','1','1','1');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  const indexes = db.value(c, "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('runs_task', 'permission_requests_task')");
  assert.equal(indexes, 2, "the indexes of version 64");
  assert.equal(get_project(c, "pr")!.archived_at, null);
  const t = get_task(c, "s")!;
  assert.deepEqual([t.number, t.work_dir, is_scratch(t)], [1, "/old", true]);
  c.close();
});

test("a_database_where_stars_and_reminders_were_version_42_keeps_them", () => {
  const path = db_path();
  // As a build of stars and reminders from before archived projects and scratch tasks took versions 42 and 43 left it.
  prepare_at(
    path,
    `ALTER TABLE projects DROP COLUMN archived_at;
                 ALTER TABLE tasks DROP COLUMN work_dir;
                 ALTER TABLE tasks DROP COLUMN title_pinned;
                 ALTER TABLE tasks DROP COLUMN queued_user_text;
                 ALTER TABLE claude_configs DROP COLUMN show_usage; ALTER TABLE tasks DROP COLUMN done_at;
                 PRAGMA user_version=42;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,status,starred,remind_at,reminder,queued_message,queued_from_agent,last_activity_at,created_at,updated_at)
                   VALUES ('t','p','task',1,'Later','todo',1,'2030-01-01T00:00:00.000Z','Look again','and the docs',0,'1','1','1'),
                          ('u','p','task',2,'Other','todo',0,NULL,NULL,'from an agent',1,'1','1','1');`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  const t = get_task(c, "t")!;
  assert.deepEqual([t.starred, t.remind_at, t.reminder], [true, "2030-01-01T00:00:00.000Z", "Look again"]);
  // A message queued before is the user's unless other agents sent all of it.
  assert.equal(t.queued_user_text, "and the docs");
  assert.equal(get_task(c, "u")!.queued_user_text, null);
  c.close();
});

test("scratch_chats_become_scratch_tasks", () => {
  const dir = temp_dir();
  const path = join(dir, "huntaway.db");
  // As version 41 left it, with a project's scratch chat, two of the profile's and a project that has the key scratch
  // tasks now use.
  prepare_at(
    path,
    `ALTER TABLE tasks DROP COLUMN work_dir;
                 ALTER TABLE projects DROP COLUMN archived_at;
                 ALTER TABLE tasks DROP COLUMN title_pinned;
                 ALTER TABLE tasks DROP COLUMN queued_user_text;
                 ALTER TABLE claude_configs DROP COLUMN show_usage; ALTER TABLE tasks DROP COLUMN done_at;
                 PRAGMA user_version=41;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('pr','p','Site','S','/src/site','/data/projects/pr/scratch','/w','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('sp','p','Spare','SP','/src/spare','/s','/w','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,former_keys,created_at)
                   VALUES ('aa','p','Again','AA','/src/again','/s','/w','["sp2"]','1');
                 INSERT INTO tasks (id,profile_id,project_id,kind,number,title,status,last_activity_at,created_at,updated_at)
                   VALUES ('old','p','aa','task',1,'Old','todo','1','1','1');
                 INSERT INTO tasks (id,profile_id,project_id,kind,number,title,status,last_activity_at,created_at,updated_at)
                   VALUES ('code','p','pr','task',1,'Code','in_review','1','1','1');
                 INSERT INTO tasks (id,profile_id,project_id,kind,title,status,session_id,last_activity_at,created_at,updated_at)
                   VALUES ('b','p',NULL,'scratch','Second','todo','s2','3','3','3');
                 INSERT INTO tasks (id,profile_id,project_id,kind,title,status,last_activity_at,created_at,updated_at)
                   VALUES ('a','p','pr','scratch','First','todo','2','2','2');`,
  );
  const c = open(path);
  const a = get_task(c, "a")!;
  const b = get_task(c, "b")!;
  for (const t of [a, b]) {
    assert.ok(is_scratch(t), JSON.stringify(t));
    assert.deepEqual([t.project_id, t.status, t.resolution], [null, "done", "done"]);
  }
  // Numbered in the order they were made, each working where its conversation is.
  assert.deepEqual([a.number, a.work_dir], [1, "/data/projects/pr/scratch"]);
  const profile_dir = path_str(join(dir, "profiles", "p", "scratch"));
  assert.deepEqual([b.number, b.work_dir, b.session_id], [2, profile_dir, "s2"]);
  assert.equal(scratch_task_by_number(c, "p", 2)!.id, "b");
  // The project's tasks stay as they were, and it gives up the key S, for one no other project has now (SP) or had
  // before (SP2, whose tasks it still names).
  assert.equal(get_task(c, "code")!.status, "in_review");
  assert.equal(get_project(c, "pr")!.key, "SP3");
  // New ones carry on the numbers.
  const p = get_profile(c, "p")!;
  const t = insert_scratch_task(c, nt(p.id));
  assert.deepEqual([t.number, t.work_dir, is_scratch(t)], [3, null, true]);
  c.close();
});

test("a_database_from_version_38_gets_permission_request_kinds", () => {
  const path = db_path();
  // As version 38 (task documents) left it, before permission requests had a kind (and projects their old keys,
  // repository root and archived time, and tasks stars, reminders, pinned titles and queued users' text).
  prepare_at(path, (c) => {
    c.exec(
      `ALTER TABLE permission_requests DROP COLUMN kind;
                 ALTER TABLE projects DROP COLUMN former_keys;
                 ALTER TABLE projects DROP COLUMN repo_root;
                 ALTER TABLE tasks DROP COLUMN work_dir;
                 ALTER TABLE projects DROP COLUMN archived_at;
                 ALTER TABLE tasks DROP COLUMN starred;
                 ALTER TABLE tasks DROP COLUMN remind_at;
                 ALTER TABLE tasks DROP COLUMN reminder;
                 ALTER TABLE profiles DROP COLUMN github_account;
                 ALTER TABLE projects DROP COLUMN github_account;
                 ALTER TABLE tasks DROP COLUMN title_pinned;
                 ALTER TABLE tasks DROP COLUMN queued_user_text;
                 ALTER TABLE claude_configs DROP COLUMN show_usage; ALTER TABLE tasks DROP COLUMN done_at;
                 PRAGMA user_version=38;`,
    );
    db.run(c, "INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1')");
    db.run(c, "INSERT INTO tasks (id,profile_id,kind,title,last_activity_at,created_at,updated_at) VALUES ('t','p','scratch','t','1','1','1')");
    db.run(c, "INSERT INTO permission_requests (id,task_id,message_id,tool_name,input,created_at) VALUES ('r','t',1,'Bash','{}','1')");
    db.run(c, "INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at) VALUES ('x','p','x','X','/x','/s','/w','1')");
  });
  const c = open(path);
  const kind = db.value(c, "SELECT kind FROM permission_requests WHERE id='r'");
  assert.deepEqual([user_version(c), kind], [VERSION, "tool"]);
  // Projects from before aren't archived.
  assert.equal(get_project(c, "x")!.archived_at, null);
  const t = get_task(c, "t")!;
  assert.deepEqual([t.starred, t.remind_at, t.reminder], [false, null, null]);
  c.close();
});

test("profile_config_dirs_become_claude_configs", () => {
  const c = open(":memory:");
  // Back to how version 17 left things.
  c.exec(
    `DROP TABLE claude_configs;
             ALTER TABLE profiles DROP COLUMN claude_config_ids;
             ALTER TABLE projects DROP COLUMN claude_config_ids;
             ALTER TABLE tasks DROP COLUMN claude_config_id;
             PRAGMA user_version=17;`,
  );
  for (const [id, name, dir, at] of [
    ["a", "work", "~/.claude-work", "1"],
    ["b", "personal", "~/.claude-me", "2"],
    ["c", "work2", "~/.claude-work", "3"],
  ]) {
    db.run(c, "INSERT INTO profiles (id,name,claude_config_dir,created_at) VALUES (?1,?2,?3,?4)", id, name, dir, at);
  }
  for (const [id, profile, session] of [
    ["t1", "a", "s1"],
    ["t2", "b", null],
  ]) {
    db.run(
      c,
      "INSERT INTO tasks (id,profile_id,kind,title,session_id,last_activity_at,created_at,updated_at) VALUES (?1,?2,'scratch','t',?3,'1','1','1')",
      id,
      profile,
      session,
    );
  }
  migrate_claude_configs(c);
  const configs = list_claude_configs(c);
  assert.deepEqual(
    configs.map((c) => [c.name, c.config_dir]),
    [
      ["personal", "~/.claude-me"],
      ["work", "~/.claude-work"],
    ],
  );
  const a = get_profile(c, "a")!;
  // Profiles that shared a directory share its config.
  assert.deepEqual(a.claude_config_ids, get_profile(c, "c")!.claude_config_ids);
  assert.equal(a.claude_config_dir, "~/.claude-work");
  // Threads keep their profile's config, whatever the profile picks later.
  assert.equal(get_task(c, "t1")!.claude_config_id, a.claude_config_ids[0] ?? null);
  update_profile(c, "a", [["claude_config_ids", get_profile(c, "b")!.claude_config_ids]]);
  assert.equal(task_config_dir(c, get_task(c, "t1")!), "~/.claude-work");
  assert.equal(task_config_dir(c, get_task(c, "t2")!), "~/.claude-me");
  assert.equal(user_version(c), 18);
});

// HA-238: a config's folder changed while a thread had a conversation in it (and was changed back). The thread goes on
// in the folder its conversation is in, as the config's settings say, rather than not finding it in the new one.
test("a_thread_goes_on_in_the_folder_its_conversation_started_in", () => {
  const c = open(":memory:");
  const dir = temp_dir();
  const old_dir = join(dir, "claude-a");
  mkdirSync(old_dir);
  const cfg = insert_claude_config(c, "me", old_dir, "claude");
  const p = insert_profile(c, "p", [cfg.id], null);
  insert_project(c, np(p.id));
  const started = (session: string | null, at: string | null) => {
    const t = insert_task(c, nt(p.id, { project_id: "pr", claude_config_id: cfg.id }));
    const r = insert_run(c, t.id, "prompt");
    set_run_config_dir(c, r.id, at);
    if (session != null) {
      set_run_session(c, r.id, session);
      update_task(c, t.id, [["session_id", session]]);
    }
    return get_task(c, t.id)!;
  };
  const before = started("s1", old_dir);
  const fresh = started(null, old_dir);
  const on_default = started("s2", null);
  // A conversation from before runs kept their folder.
  const unknown = insert_task(c, nt(p.id, { project_id: "pr", claude_config_id: cfg.id }));
  update_task(c, unknown.id, [["session_id", "s3"]]);
  const new_dir = join(dir, "claude-b");
  update_claude_config(c, cfg.id, [["config_dir", new_dir]]);
  assert.equal(task_config_dir(c, before), old_dir);
  assert.equal(task_config_dir(c, on_default), null);
  // A thread that hasn't started a conversation, or whose folder isn't known, moves to the new folder.
  assert.equal(task_config_dir(c, fresh), new_dir);
  assert.equal(task_config_dir(c, get_task(c, unknown.id)!), new_dir);
  // A later run that resumed it somewhere else doesn't move it.
  const later = insert_run(c, before.id, "prompt");
  set_run_config_dir(c, later.id, new_dir);
  set_run_session(c, later.id, "s1");
  assert.equal(task_config_dir(c, before), old_dir);
  // A new conversation is kept where its run was started.
  const again = insert_run(c, before.id, "prompt");
  set_run_config_dir(c, again.id, new_dir);
  set_run_session(c, again.id, "s4");
  assert.equal(task_config_dir(c, update_task(c, before.id, [["session_id", "s4"]])!), new_dir);
  update_task(c, before.id, [["session_id", "s1"]]);
  // Its old folder gone (moved to the new one, say), it goes on in the config's.
  rmSync(old_dir, { recursive: true });
  assert.equal(task_config_dir(c, get_task(c, before.id)!), new_dir);
});

test("threads_pick_their_project_or_profile_config", () => {
  const c = open(":memory:");
  const work = insert_claude_config(c, "work", "~/.claude-work", "claude");
  const me = insert_claude_config(c, "me", "~/.claude-me", "claude");
  const p = insert_profile(c, "p", [work.id, me.id], null);
  assert.equal(p.claude_config_dir, "~/.claude-work");
  let project = insert_project(c, np(p.id));
  const task = (cfg: string | null) => insert_task(c, nt(p.id, { project_id: "pr", claude_config_id: cfg }));
  const names = (p: Project) => available_configs(c, p.profile_id, p).map((c) => c.name);
  // The profile's configs, the default first.
  assert.deepEqual(names(project), ["work", "me"]);
  let t = task(null);
  assert.equal(t.claude_config_id, work.id);
  assert.equal(task(me.id).claude_config_id, me.id);

  // A project's own list overrides the profile's.
  project = update_project(c, "pr", [["claude_config_ids", JSON.stringify([me.id])]])!;
  assert.deepEqual(names(project), ["me"]);
  // A thread keeps the config it started with.
  assert.equal(task_config_dir(c, t), "~/.claude-work");

  // Deleting a config takes it off the profile and the project, and its threads go to the default.
  delete_claude_config(c, me.id);
  project = get_project(c, "pr")!;
  assert.equal(project.claude_config_ids, null);
  assert.deepEqual(get_profile(c, p.id)!.claude_config_ids, [work.id]);
  const orphan = task(null);
  assert.equal(task_claude_config(c, orphan)?.name, "work");
  t = { ...t, claude_config_id: me.id };
  assert.equal(task_claude_config(c, t)?.name, "work");

  // A thread that started with no config at all stays in Claude's default one.
  t.claude_config_id = null;
  assert.equal(task_claude_config(c, t)?.name, "work");
  t.session_id = "s";
  assert.equal(task_claude_config(c, t), null);
});

test("threads_load_in_pages_of_main_conversation_messages", () => {
  const c = open(":memory:");
  const p = insert_profile(c, "p", [], null);
  const t = insert_task(c, nt(p.id));
  const add = (kind: string, data: any) => insert_message(c, t.id, kind, data).id;
  const text = (s: string) => ({ type: "assistant", message: { content: [{ type: "text", text: s }] } });
  const first = add("user", { text: "go" });
  // A background subagent, then its own messages, a progress line from it and a shell's.
  add("claude", {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "on it" },
        { type: "tool_use", id: "a1", name: "Agent", input: { description: "look", prompt: "p".repeat(300) } },
      ],
    },
  });
  const report = "Async agent launched successfully. ".repeat(20);
  add("claude", {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "a1", content: report }] },
    tool_use_result: { isAsync: true, content: ["big"] },
  });
  add("claude", { type: "system", subtype: "task_started", task_id: "k1", tool_use_id: "a1", is_backgrounded: true });
  add("claude", { type: "system", subtype: "task_started", task_id: "sh", tool_use_id: "b1" });
  const child = add("claude", { type: "assistant", parent_tool_use_id: "a1", message: { content: [{ type: "text", text: "reading" }] } });
  add("claude", { type: "system", subtype: "task_progress", task_id: "k1", description: "Reading a" });
  const main = add("claude", text("meanwhile"));
  add("claude", { type: "assistant", parent_tool_use_id: "a1", message: { content: [{ type: "text", text: "still reading" }] } });
  const progress = add("claude", { type: "system", subtype: "task_progress", task_id: "k1", description: "Reading b" });
  const last = add("claude", text("done"));

  const ids = ([page, more]: [Message[], boolean]) => [page.map((m) => m.id), more];
  const all = list_messages(c, t.id).map((m) => m.id);
  assert.deepEqual(ids(message_page(c, t.id, null, null, null)), [all, false]);
  // Three of the main conversation's: the subagent's messages among them don't count.
  assert.deepEqual(ids(message_page(c, t.id, null, null, 3)), [range(main, last), true]);
  // Older pages: the subagent's message is among the two before `main`, which start at a main-conversation one.
  assert.deepEqual(ids(message_page(c, t.id, null, main, 1)), [[main - 1], true]);
  assert.deepEqual(ids(message_page(c, t.id, null, main, 2)), [range(child - 1, main - 1), true]);
  assert.deepEqual(ids(message_page(c, t.id, null, main, 100)), [range(first, main - 1), false]);
  // Everything after a message, as a reload asks for.
  assert.deepEqual(ids(message_page(c, t.id, main, null, null)), [range(main + 1, last), false]);
  assert.deepEqual(message_page(c, "nope", null, null, 5)[0], []);

  // The subagent from before `last`: its call alone, its result's start, its own task_* messages (the latest progress).
  const subs = subagent_messages(c, t.id, last);
  assert.equal(subs.length, 4, JSON.stringify(subs, null, 2));
  assert.deepEqual(subs[0].data.message.content, [{ type: "tool_use", id: "a1", name: "Agent", input: { description: "look", prompt: "p".repeat(200) } }]);
  const result = subs[1].data;
  assert.equal(result.message.content[0].content.length, 200);
  assert.deepEqual(result.tool_use_result, { isAsync: true });
  assert.equal(subs[2].data.subtype, "task_started");
  assert.equal(subs[3].id, progress);
  assert.deepEqual(subagent_messages(c, t.id, first), []);

  // A megabyte of a subagent's output ends the page, at the main-conversation message before it.
  const call = add("claude", { type: "assistant", message: { content: [{ type: "tool_use", id: "a2", name: "Agent", input: {} }] } });
  add("claude", { type: "user", parent_tool_use_id: "a2", message: { content: [{ type: "tool_result", tool_use_id: "r", content: "x".repeat(PAGE_BYTES) }] } });
  add("claude", { type: "assistant", parent_tool_use_id: "a2", message: { content: [] } });
  const end = add("claude", text("end"));
  assert.deepEqual(ids(message_page(c, t.id, null, null, 100)), [range(call, end), true]);
});

test("a_threads_queries_read_only_its_own_messages", () => {
  // HA-188: with no statistics, SQLite took the (kind, created_at) index for `task_id=? AND kind=?` and read every agent
  // message on the board, which made each thread's first page take 80 ms on a big board, however short the thread.
  const c = open(":memory:");
  const p = insert_profile(c, "p", [], null);
  const t = insert_task(c, nt(p.id));
  insert_message(c, t.id, "claude", { type: "assistant", message: { content: [{ type: "tool_use", id: "a1", name: "Agent", input: {} }] } });
  const prepared: string[] = [];
  const spy = new Proxy(c, {
    get(target, k) {
      if (k === "prepare") return (sql: string) => (prepared.push(sql), target.prepare(sql));
      const v = (target as any)[k];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  subagent_messages(spy, t.id, 1 << 30);
  message_page(spy, t.id, null, null, 100);
  assert.ok(prepared.length >= 3, prepared.join("\n"));
  for (const sql of prepared) {
    const plan = db
      .all(c, `EXPLAIN QUERY PLAN ${sql}`)
      .map((r) => r.detail)
      .join("; ");
    assert.match(plan, /messages_task/, `${sql}\n${plan}`);
    assert.doesNotMatch(plan, /messages_kind_time/, `${sql}\n${plan}`);
  }
});

test("subagent_summaries_include_forked_skills_and_their_launch_calls", () => {
  const c = open(":memory:");
  const p = insert_profile(c, "p", [], null);
  const t = insert_task(c, nt(p.id, { kind: "review", title: "review" }));
  const add = (data: any) => insert_message(c, t.id, "claude", data).id;
  const call = add({
    type: "assistant",
    parent_tool_use_id: "outer",
    message: {
      content: [
        { type: "tool_use", id: "inline", name: "Skill", input: { skill: "inline" } },
        { type: "tool_use", id: "fork", name: "Skill", input: { skill: "code-review", args: "low 139" } },
      ],
    },
  });
  const start = add({
    type: "system",
    subtype: "task_started",
    task_type: "local_agent",
    tool_use_id: "fork",
    task_id: "child",
    prompt: "p".repeat(300),
    description: "/code-review",
  });
  add({ type: "assistant", parent_tool_use_id: "fork", message: { content: [{ type: "text", text: "child transcript" }] } });
  add({ type: "system", subtype: "task_started", task_type: "local_bash", tool_use_id: "shell", task_id: "shell-task" });
  const end = add({ type: "system", subtype: "task_notification", task_id: "child", status: "completed", summary: "done" });
  const result = add({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "fork", content: "review report" }] } });
  const last = add({ type: "assistant", message: { content: [{ type: "text", text: "main summary" }] } });
  const subs = subagent_messages(c, t.id, last);
  assert.deepEqual(
    subs.map((m) => m.id),
    [call, start, end, result],
  );
  assert.equal(subs[0].data.message.content.length, 1);
  assert.equal(subs[0].data.message.content[0].id, "fork");
  assert.equal(subs[0].data.parent_tool_use_id, "outer");
  assert.equal(subs[1].data.prompt.length, 200);
  // A page can start between the Skill call and its task_started event.
  const split = subagent_messages(c, t.id, start);
  assert.deepEqual(
    split.map((m) => m.id),
    [call],
  );
});

test("dependencies_stay_in_the_project_and_never_loop", () => {
  const c = open(":memory:");
  const p = insert_profile(c, "p", [], null);
  for (const [id, key] of [
    ["a", "A"],
    ["b", "B"],
  ])
    insert_project(c, np(p.id, id, key));
  const task = (project: string) => insert_task(c, nt(p.id, { project_id: project }));
  const [one, two, three, other] = [task("a"), task("a"), task("a"), task("b")];
  const check = (t: Task, ids: string[]) => check_dependencies(c, t.id, t.project_id, ids);
  assert.deepEqual(check(two, [one.id, one.id]), [one.id]);
  assert.throws(() => check(two, [two.id]));
  assert.throws(() => check(two, [other.id]));
  assert.throws(() => check(two, ["nope"]));
  update_task(c, two.id, [["depends_on", [one.id]]]);
  update_task(c, three.id, [["depends_on", [two.id]]]);
  // one → two → three, so one can't depend on three.
  assert.throws(() => check(get_task(c, one.id)!, [three.id]), /already depends/);

  const unmet = (t: Task) => unmet_dependencies(c, get_task(c, t.id)!).map((t) => t.id);
  assert.deepEqual(unmet(three), [two.id]);
  // Closed without being merged doesn't count.
  update_task(c, two.id, [
    ["status", "done"],
    ["resolution", "wont_fix"],
  ]);
  assert.deepEqual(unmet(three), [two.id]);
  update_task(c, two.id, [["resolution", "done"]]);
  assert.deepEqual(unmet(three), []);

  // A deleted task comes off its dependents' lists.
  db.run(c, "DELETE FROM tasks WHERE id=?1", one.id);
  assert.deepEqual(drop_dependency(c, one.id), [two.id]);
  assert.deepEqual(get_task(c, two.id)!.depends_on, []);
  assert.deepEqual(get_task(c, three.id)!.depends_on, [two.id]);
});

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// HA-108: a run that resumed a session was charged for the session's earlier runs again.
test("a_database_from_version_72_counts_each_runs_cost_once", () => {
  const path = db_path();
  let task = "";
  let thread = "";
  prepare_at(path, (c) => {
    const p = insert_profile(c, "me", [], null);
    [task, thread] = [insert_task(c, nt(p.id)).id, insert_task(c, nt(p.id, { kind: "review" })).id];
    c.exec("ALTER TABLE runs DROP COLUMN session_id; ALTER TABLE runs DROP COLUMN session_cost; PRAGMA user_version=72;");
    // Each run's cost was its session's total, and the task was charged each run's whole total. The task's runs: a
    // session, then one that ended before its first result, then a new session (its total is lower). The thread's: two
    // review rounds, the first with a reply.
    const runs: Array<[string, string, string, number]> = [
      [task, "a", "prompt", 1.0],
      [task, "b", "prompt", 1.5],
      [task, "c", "compact", 0.0],
      [task, "d", "prompt", 0.4],
      [task, "e", "prompt", 0.9],
      [thread, "f", "review", 0.5],
      [thread, "g", "prompt", 0.7],
      [thread, "h", "review", 0.6],
    ];
    for (const [task_id, id, kind, cost] of runs) {
      db.run(c, "INSERT INTO runs (id,task_id,kind,status,cost_usd,created_at) VALUES (?1,?2,?3,'exited',?4,'1')", id, task_id, kind, cost);
    }
    // 0.2 of the task's is from runs before runs had a cost.
    db.run(c, "UPDATE tasks SET cost_usd=4.0, session_id='s2' WHERE id=?1", task);
    db.run(c, "UPDATE tasks SET cost_usd=1.8, session_id='r2' WHERE id=?1", thread);
    for (const [r, cost] of [
      ["b", 1.5],
      ["b", 0.1],
      ["e", 0.9],
    ] as const) {
      db.run(c, "INSERT INTO context_stats (task_id,run_id,kind,at,cost_usd) VALUES (?1,?2,'turn','1',?3)", task, r, cost);
    }
  });
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  const costs = (sql: string): number[] => db.all(c, sql).map((r) => r.cost_usd);
  const runs = costs("SELECT cost_usd FROM runs ORDER BY rowid");
  assert.ok(
    [1.0, 0.5, 0.0, 0.4, 0.5, 0.5, 0.2, 0.6].every((b, i) => close(runs[i], b)),
    JSON.stringify(runs),
  );
  const tasks = [get_task(c, task)!.cost_usd, get_task(c, thread)!.cost_usd];
  assert.ok(close(tasks[0], 2.6) && close(tasks[1], 1.3), JSON.stringify(tasks));
  const turns = costs("SELECT cost_usd FROM context_stats ORDER BY id");
  assert.ok(
    [0.5, 0.1, 0.5].every((b, i) => close(turns[i], b)),
    JSON.stringify(turns),
  );
  // The runs of each thread's current session are in it, for the next run's cost to go on from.
  const sessions = db.all(c, "SELECT id, session_id, session_cost FROM runs ORDER BY rowid").map((r) => [r.id, r.session_id, r.session_cost]);
  const s = (id: string, session: string | null, cost: number | null) => [id, session, cost];
  const none = (id: string) => s(id, null, null);
  assert.deepEqual(sessions, [none("a"), none("b"), none("c"), s("d", "s2", 0.4), s("e", "s2", 0.9), none("f"), none("g"), s("h", "r2", 0.6)]);
  const next = insert_run(c, task, "prompt");
  assert.ok(close(add_cost(c, next.id, "s2", 1.2, true), 0.3));
  c.close();
});

// HA-108: a new session's runs that cost more than the old session's are a session of their own.
test("a_database_from_version_72_keeps_new_sessions_apart", () => {
  const path = db_path();
  let rewound = "";
  let checkpointed = "";
  prepare_at(path, (c) => {
    const p = insert_profile(c, "me", [], null);
    [rewound, checkpointed] = [insert_task(c, nt(p.id)).id, insert_task(c, nt(p.id)).id];
    c.exec("ALTER TABLE runs DROP COLUMN session_id; ALTER TABLE runs DROP COLUMN session_cost; PRAGMA user_version=72;");
    // One task rewound to its first message between its runs, which started a new conversation (that cost more than the
    // first); then a run of it that hadn't said its total yet. The other's checkpoints say its runs were in different
    // sessions, then the same.
    const runs: Array<[string, string, number, string]> = [
      [rewound, "a", 1.0, "1"],
      [rewound, "b", 2.0, "3"],
      [rewound, "c", 0.0, "4"],
      [checkpointed, "d", 1.0, "1"],
      [checkpointed, "e", 2.0, "2"],
      [checkpointed, "f", 2.5, "3"],
    ];
    for (const [task_id, id, cost, at] of runs) {
      db.run(c, "INSERT INTO runs (id,task_id,kind,status,cost_usd,created_at) VALUES (?1,?2,'prompt','exited',?3,?4)", id, task_id, cost, at);
    }
    const text = "Rewound to before turn 1: 1 file restored, 0 files removed; the next message starts a new conversation";
    db.run(c, "INSERT INTO messages (task_id,kind,data,created_at) VALUES (?1,'event',?2,'2')", rewound, JSON.stringify({ level: "info", text }));
    for (const [n, r, session] of [
      [1, "d", "k1"],
      [2, "e", "k2"],
      [3, "f", "k2"],
    ] as const) {
      db.run(
        c,
        "INSERT INTO checkpoints (task_id,n,kind,sha,tree,run_id,session,created_at) VALUES (?1,?2,'turn','s','t',?3,?4,'1')",
        checkpointed,
        n,
        r,
        session,
      );
    }
    db.run(c, "UPDATE tasks SET cost_usd=3.0, session_id='new' WHERE id=?1", rewound);
    db.run(c, "UPDATE tasks SET cost_usd=5.5, session_id='k2' WHERE id=?1", checkpointed);
  });
  const c = open(path);
  const runs = db.all(c, "SELECT id, cost_usd, session_id, session_cost FROM runs ORDER BY rowid");
  const want: Array<[string, number, string | null, number | null]> = [
    ["a", 1.0, null, null],
    ["b", 2.0, "new", 2.0],
    ["c", 0.0, "new", null],
    ["d", 1.0, null, null],
    ["e", 2.0, "k2", 2.0],
    ["f", 0.5, "k2", 2.5],
  ];
  assert.equal(runs.length, want.length);
  runs.forEach((got, i) => {
    const w = want[i];
    assert.ok(
      got.id === w[0] && close(got.cost_usd, w[1]) && got.session_id === w[2] && got.session_cost === w[3],
      `${JSON.stringify(got)} ${JSON.stringify(w)}`,
    );
  });
  const tasks = [get_task(c, rewound)!.cost_usd, get_task(c, checkpointed)!.cost_usd];
  assert.ok(close(tasks[0], 3.0) && close(tasks[1], 3.5), JSON.stringify(tasks));
  // The run of the new conversation that was going during the upgrade starts from nothing.
  assert.ok(close(add_cost(c, "c", "new", 0.25, true), 0.25));
  c.close();
});

test("a_database_from_version_93_keeps_its_prompts_waiting_without_an_expiry", () => {
  const path = db_path();
  prepare_at(
    path,
    `PRAGMA foreign_keys=OFF; DROP INDEX permission_requests_expiry; ALTER TABLE permission_requests DROP COLUMN expires_at;
     ALTER TABLE permission_requests DROP COLUMN rule; DROP TABLE push_answer_tokens; DROP TABLE approval_log;
     INSERT INTO permission_requests (id,task_id,message_id,tool_name,input,status,created_at,call_id,kind) VALUES ('p','t',1,'Bash','{}','pending','1','c','tool');
     PRAGMA user_version=93;`,
  );
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  // A prompt from before has no expiry or rule, so it waits as it did.
  assert.deepEqual(
    { ...(db.one(c, "SELECT status, expires_at, rule FROM permission_requests WHERE id='p'") as any) },
    { status: "pending", expires_at: null, rule: null },
  );
  db.run(c, "INSERT INTO push_answer_tokens (token_hash,request_id,host_id,task_id,created_at,expires_at) VALUES ('h','p','x','t','1','2')");
  assert.equal(db.value(c, "SELECT status FROM push_answer_tokens WHERE token_hash='h'"), "pending");
  db.run(
    c,
    "INSERT INTO approval_log (id,profile_id,task_id,tool_name,summary,rule,decision,outcome,created_at) VALUES ('l','p','t','x','','x','ask','pending','1')",
  );
  c.close();
  // A database that has some of it already (another migration took the number first) gets the rest.
  const partial = db_path();
  prepare_at(partial, "DROP TABLE approval_log; ALTER TABLE push_answer_tokens DROP COLUMN expires_at; PRAGMA user_version=93;");
  const c2 = open(partial);
  assert.ok(has_column(c2, "push_answer_tokens", "expires_at") && has_column(c2, "permission_requests", "rule"));
  assert.equal(db.value(c2, "SELECT COUNT(*) FROM approval_log"), 0);
  c2.close();
});

test("a_database_from_version_99_has_its_workflows_approvals_say_workflow", () => {
  const path = db_path();
  let task = "";
  prepare_at(path, (c) => {
    const p = insert_profile(c, "p", [], null);
    task = insert_task(c, nt(p.id, {})).id;
    const ask = (kind: string, input: any) =>
      db.run(
        c,
        "INSERT INTO messages (task_id, kind, data, created_at) VALUES (?1, 'permission', ?2, '1')",
        task,
        JSON.stringify({ kind, tool_name: "t", input, status: "allowed" }),
      );
    ask("automation", { op: "create", workflow: { name: "W" } });
    ask("automation", { op: "create", automation: { name: "A" } });
    ask("project", { workflow: "not one" });
    const request = (id: string, kind: string, input: any) =>
      db.run(
        c,
        "INSERT INTO thread_requests (task_id, id, pos, type, open, data, created_at, updated_at) VALUES (?1, ?2, ?3, 'permission', 0, ?4, '1', '1')",
        task,
        id,
        id === "r1" ? 1 : 2,
        JSON.stringify({ id, type: "permission", input, metadata: { kind, tool_name: "t", status: "allowed" } }),
      );
    request("r1", "automation", { op: "delete", workflow: { name: "W" } });
    request("r2", "automation", { op: "delete", automation: { name: "A" } });
    c.exec("PRAGMA user_version=99;");
  });
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  const kinds = db.all(c, "SELECT json_extract(data, '$.kind') AS k FROM messages WHERE task_id=?1 ORDER BY id", task).map((r: any) => r.k);
  assert.deepEqual(kinds, ["workflow", "automation", "project"]);
  const requests = db.all(c, "SELECT json_extract(data, '$.metadata.kind') AS k FROM thread_requests WHERE task_id=?1 ORDER BY pos", task).map((r: any) => r.k);
  assert.deepEqual(requests, ["workflow", "automation"]);
  c.close();
});

test("a_database_from_version_104_keeps_its_published_documents_with_no_account", () => {
  // HA-286: documents published before the account was kept are taken as the connected account's.
  const path = db_path();
  const c0 = open(path);
  const p = db.insert_profile(c0, "p", [], null);
  const page = { path: "index", title: "T", format: "md", source: "# T", position: 0 };
  db.publish_doc(c0, { profile_id: p.id, slug: "d", title: "T", message: null, pages: [page], merge: false, delete: [], task_id: null, run_id: null });
  const doc_id = db.get_doc(c0, p.id, "d")!.id;
  c0.close();
  prepare_at(path, (c) => {
    c.exec("ALTER TABLE docs_site_published DROP COLUMN login; PRAGMA user_version=104;");
    db.run(
      c,
      "INSERT INTO docs_site_published (doc_id, site_url, remote_slug, remote_version, local_version, url, version_url, published_at) VALUES (?1,'https://s','d',1,1,'https://s/d/','https://s/d/-/v/1/','2026-11-07')",
      doc_id,
    );
  });
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  assert.deepEqual([db.docs_site_published(c, doc_id, "https://s")?.remote_slug, db.docs_site_published(c, doc_id, "https://s")?.login], ["d", null]);
});

test("a_database_from_ha_276s_version_104_gets_the_hosted_docs_tables_it_skipped", () => {
  // HA-276's branch had `runs.finished` as version 104, so its databases (its PR preview's) skipped master's 104, the
  // hosted docs tables; 105 makes them.
  const path = db_path();
  open(path).close();
  prepare_at(path, (c) => c.exec("DROP TABLE docs_site_published; DROP TABLE docs_site_connections; DROP TABLE docs_site_clients; PRAGMA user_version=104;"));
  const c = open(path);
  assert.equal(user_version(c), VERSION);
  for (const [table, column] of [
    ["runs", "finished"],
    ["docs_site_published", "login"],
    ["docs_site_connections", "site_url"],
    ["docs_site_clients", "client_id"],
  ])
    assert.ok(has_column(c, table, column), `${table}.${column}`);
  c.close();
});
