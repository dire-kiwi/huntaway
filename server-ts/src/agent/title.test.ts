// Port of the tests in server/src/agent/title.rs.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as db from "../db.ts";
import type { NewTask, Task } from "../db.ts";
import * as api from "../api.ts";
import type { Shared } from "../state.ts";
import * as testing from "../testing.ts";
import * as calls from "./tokens/calls.ts";
import {
  AGENT_CHARS,
  MESSAGE_CHARS,
  MESSAGES,
  TEST,
  begin_refresh,
  clean,
  end_refresh,
  generate,
  new_title,
  placeholder,
  refresh,
  refresh_input,
  worth_asking,
} from "./title.ts";

TEST.on = true;
beforeEach(() => TEST.reset());

/** Let the background refreshes finish (the test reply doesn't wait for anything). */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

const reply = (title: string) => (TEST.reply = title);
const asked = () => TEST.asked;

/** A gate a test reply waits on (Rust's `Notify`): `open` lets it through, before or after it's waited on. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

function new_task(profile_id: string, title: string, description: string, status: string): NewTask {
  return { profile_id, project_id: null, kind: "task", title, description, status, use_worktree: false, model: null, effort: null, claude_config_id: null };
}

const update = (s: Shared, id: string, b: Record<string, any>) => api.update_task_inner(s, id, b);

test("refresh_input_has_the_users_messages_with_what_the_agent_asked", () => {
  const state = testing.state();
  const p = db.insert_profile(state.db(), "p", [], null);
  const task: Task = { ...db.insert_task(state.db(), new_task(p.id, "Fix login", "The login page 500s", "in_progress")) };
  task.steering = [
    { id: "a", text: "and the logout page", from_agent: false, run_id: "r", written: true },
    { id: "b", text: "from another agent", from_agent: true, run_id: "r", written: true },
  ] as any;
  task.queued_message = "an agent's request\n\nthen deploy it";
  task.queued_user_text = "then deploy it";
  const question = `${"x".repeat(400)}Should I fix the session too?`;
  const replies: Array<[string | null, string]> = [
    [null, "Use the new API"],
    [question, "Yes"],
  ];
  assert.equal(
    refresh_input(task, replies, "Merged. What next?", 0),
    `<title>Fix login</title>\n\n<task>\nThe login page 500s\n</task>\n\n<message>\nUse the new API\n</message>\n\n<message>\n<agent>…${"x".repeat(AGENT_CHARS - 29)}Should I fix the session too?</agent>\nYes\n</message>\n\n<message>\n<agent>Merged. What next?</agent>\nand the logout page\n</message>\n\n<message>\nthen deploy it\n</message>\n`,
  );
  // Only the latest messages go, each cut short.
  const many: Array<[string | null, string]> = Array.from({ length: MESSAGES + 5 }, (_, i) => [null, `${i}${"y".repeat(MESSAGE_CHARS)}`]);
  task.steering = [];
  task.queued_user_text = null;
  const input = refresh_input(task, many, null, 0);
  assert.ok(refresh_input(task, many.slice(5), null, 5) === input, input);
  assert.ok(input.includes("(5 earlier messages left out)") && !input.includes("\n4y") && input.includes("\n5y"), input);
  assert.ok(input.includes(`\n34${"y".repeat(MESSAGE_CHARS - 2)}…\n</message>`), input);
});

test("replies_keep_the_title_or_give_a_short_one", () => {
  assert.equal(new_title("Add a logout button", "Fix login"), "Add a logout button");
  assert.equal(new_title(clean("KEEP"), "Fix login"), null);
  assert.equal(new_title(clean("Keep."), "Fix login"), null);
  assert.equal(new_title(clean("`KEEP`"), "Fix login"), null);
  assert.equal(new_title("", "Fix login"), null);
  assert.equal(new_title("Agent-controlled project settings with approval gate, no delete and a sturdier update", "Fix login"), null);
});

test("a_sentence_saying_to_keep_the_title_keeps_it", () => {
  // HA-196: Codex answered with a sentence instead of KEEP, and the task was renamed to it.
  assert.equal(clean("Keep the task title “Say hello”"), "Keep the task title “Say hello");
  assert.equal(new_title(clean("Keep the task title “Say hello”."), "Say hello"), null);
  assert.equal(new_title(clean("Keep the task title “Say hello”"), "Say hello"), null);
  for (const r of [
    "KEEP: the title still fits",
    "KEEP — nothing changed",
    "Keep the current title",
    "Keep the task's title unchanged",
    "Keep it as is",
    "Keep “Say hello”",
    "Keep the title as “Say hello”",
    "Keep the existing title 'Say hello' unchanged",
    "The title still fits",
    "The current title is fine",
    "No change",
    "Keep “Say hello” as the title",
    "Keep the title unchanged: “Say hello”",
    "Keep the title as is: Say hello",
    "The title “Say hello” still fits",
    "Keep as is",
    "Keep unchanged",
    "Keep — nothing changed",
    "Title unchanged",
    "Unchanged",
    "No changes",
    "No changes needed",
    "No title change",
  ])
    assert.equal(new_title(clean(r), "Say hello"), null, r);
  // A title that starts with "Keep" is still a title, even one that mentions a title or the task's current one.
  for (const [r, current] of [
    ["Keep sessions alive after logout", "Fix login"],
    ["Keep the title bar visible on scroll", "Fix the header"],
    ["Keep the task title in sync with the branch", "Rename branches"],
    ["Keep dark mode in sync across tabs", "Dark mode"],
    ["Keep it simple", "Fix login"],
    ["Keeper of the logs", "Fix login"],
    ["Keep the task list sorted", "Say hello"],
    ["Say hello in French", "Say hello"],
  ])
    assert.equal(new_title(clean(r), current), r);
});

test("a_codex_sentence_saying_to_keep_the_title_doesnt_retitle_the_task", async () => {
  const s = testing.state();
  const p = db.insert_profile(s.db(), "p", [], null);
  const task = db.insert_task(s.db(), new_task(p.id, "Say hello", "Say hello", "in_review"));
  s.add_message(task.id, "user", { text: "Say it again" });
  reply("Keep the task title “Say hello”.");
  refresh(s, task.id);
  await settle();
  // Taken for KEEP the first time, so it isn't asked again either.
  assert.deepEqual([db.get_task(s.db(), task.id)!.title, asked().length], ["Say hello", 1]);
});

test("links_and_attachments_alone_dont_ask_for_a_title", () => {
  assert.ok(!worth_asking("  https://example.com/shot.png\n"));
  assert.ok(!worth_asking("Attached files:\n- /data/attachments/0123/shot.png"));
  assert.ok(!worth_asking(""));
  assert.ok(worth_asking("see https://example.com/shot.png"));
  assert.ok(worth_asking("Make it blue\n\nAttached files:\n- /data/attachments/0123/shot.png"));
});

test("a_refresh_that_ends_late_isnt_taken_for_a_later_one", () => {
  // A is slow; B, asked after it, ends first; then C is asked, and A ends before C.
  const a = begin_refresh("t");
  const b = begin_refresh("t");
  assert.ok(end_refresh("t", b));
  const c = begin_refresh("t");
  assert.ok(!end_refresh("t", a), "A is out of date");
  assert.ok(end_refresh("t", c), "C is the latest");
  assert.ok(!end_refresh("t", c));
});

test("a_message_sent_while_the_first_title_is_written_has_the_last_word", async () => {
  const s = testing.state();
  const p = db.insert_profile(s.db(), "p", [], null);
  const fresh = () => db.insert_task(s.db(), new_task(p.id, "Investigate the original issue", "Investigate the original issue", "todo"));
  const title = (id: string) => db.get_task(s.db(), id)!.title;
  // Each way round: the first title is written, then the refresh for a message sent meanwhile ends, or the other way
  // about. The refresh's title wins either way, and its KEEP keeps the first.
  for (const [first_ends_first, refreshed, expected] of [
    [true, "Add an export button", "Add an export button"],
    [false, "Add an export button", "Add an export button"],
    [true, "KEEP", "Fix the original issue"],
  ] as Array<[boolean, string, string]>) {
    const task = fresh();
    const generating = gate(), refreshing = gate();
    TEST.replies.push(["Fix the original issue", generating.wait], [refreshed, refreshing.wait]);
    generate(s, task, null);
    s.add_message(task.id, "user", { text: "Instead, add an export button" });
    refresh(s, task.id);
    await settle();
    for (const g of first_ends_first ? [generating, refreshing] : [refreshing, generating]) {
      g.open();
      await settle();
    }
    assert.equal(title(task.id), expected, `first title ends first: ${first_ends_first}, refresh replies ${refreshed}`);
  }
  // A rename by hand still wins over both.
  const task = fresh();
  const refreshing = gate();
  TEST.replies.push(["Add an export button", refreshing.wait]);
  s.add_message(task.id, "user", { text: "Instead, add an export button" });
  refresh(s, task.id);
  await settle();
  await update(s, task.id, { title: "Mine" });
  refreshing.open();
  await settle();
  assert.equal(title(task.id), "Mine");
});

test("other_agents_queued_messages_dont_retitle_a_task", async () => {
  const s = testing.state();
  const p = db.insert_profile(s.db(), "p", [], null);
  const task = db.insert_task(s.db(), new_task(p.id, "Add search", "", "in_progress"));
  db.queue(s.db(), task.id, db.Queued_new("Build a payment gateway", true));
  reply("Build a payment gateway");
  refresh(s, task.id);
  await settle();
  // Nothing of the user's to go on, so it isn't asked.
  assert.deepEqual(asked(), []);
  db.queue(s.db(), task.id, db.Queued_new("and cache the results", false));
  refresh(s, task.id);
  await settle();
  assert.ok(asked().length === 1 && asked()[0].includes("and cache the results") && !asked()[0].includes("payment"), String(asked()));
});

test("a_message_sent_again_goes_once", () => {
  const state = testing.state();
  const p = db.insert_profile(state.db(), "p", [], null);
  const task: Task = { ...db.insert_task(state.db(), new_task(p.id, "Fix login", "", "in_progress")) };
  const count = (s: string, w: string) => s.split(w).length - 1;
  task.queued_user_text = "wrong browser ";
  let input = refresh_input(task, [[null, "wrong browser"]], null, 0);
  assert.equal(count(input, "wrong browser"), 1, input);
  input = refresh_input(task, [[null, "wrong browser"], [null, "wrong browser"]], null, 0);
  assert.equal(count(input, "wrong browser"), 1, input);

  // The same words answering a different question are a different message, whether the agent has taken them in yet or
  // not.
  const replies: Array<[string | null, string]> = [
    ["A: add a cache; B: add search", "Use option B"],
    ["A: keep the index; B: replace it", "Use option B"],
  ];
  task.queued_user_text = null;
  input = refresh_input(task, replies, null, 0);
  assert.ok(count(input, "Use option B") === 2 && input.includes("<agent>A: keep the index; B: replace it</agent>\nUse option B"), input);
  task.queued_user_text = "Use option B";
  input = refresh_input(task, replies.slice(0, 1), "A: keep the index; B: replace it", 0);
  assert.ok(count(input, "Use option B") === 2 && input.includes("<agent>A: keep the index; B: replace it</agent>\nUse option B"), input);
});

test("prompts_retitle_a_task_unless_its_title_is_pinned", async () => {
  const s = testing.state();
  const p = db.insert_profile(s.db(), "p", [], null);
  const task = db.insert_task(s.db(), new_task(p.id, "Fix login", "The login page 500s", "in_review"));
  const title = () => db.get_task(s.db(), task.id)!.title;
  s.add_message(task.id, "user", { text: "Now add a logout button" });
  reply('"Add a logout button."');
  refresh(s, task.id);
  await settle();
  assert.equal(title(), "Add a logout button");
  assert.ok(asked()[0].includes("<title>Fix login</title>") && asked()[0].includes("Now add a logout button"), String(asked()));

  // Renamed by hand, it keeps its name.
  let t = await update(s, task.id, { title: "Logout" });
  assert.ok(t.title_pinned);
  reply("Something else");
  refresh(s, task.id);
  await settle();
  assert.deepEqual([title(), asked().length], ["Logout", 1]);
  // Saving it unchanged leaves it pinned.
  t = await update(s, task.id, { title: "Logout", status: "in_progress" });
  assert.ok(t.title_pinned);

  // Unpinned, it catches up at once.
  t = await update(s, task.id, { title_pinned: false });
  assert.ok(!t.title_pinned);
  await settle();
  assert.deepEqual([title(), asked().length], ["Something else", 2]);
  await assert.rejects(update(s, task.id, { title_pinned: "no" }));

  // A rename while the title is being written wins (the save checks the title it started from).
  assert.equal(db.replace_title(s.db(), task.id, "Fix login", "Late"), null);
  assert.equal(title(), "Something else");
  // A reply that it still fits keeps it.
  reply("KEEP");
  refresh(s, task.id);
  await settle();
  assert.equal(title(), "Something else");
  // A reply that's no title is asked again, once.
  const before = asked().length;
  reply("The latest message asks for a manual button in project settings, which is a new goal, so the title should change");
  refresh(s, task.id);
  await settle();
  assert.deepEqual([title(), asked().length], ["Something else", before + 2]);
  // A failed call leaves the title alone.
  TEST.reply = null;
  refresh(s, task.id);
  await settle();
  assert.equal(title(), "Something else");
});

test("each_title_call_keeps_its_tokens_for_the_task_failed_or_not", async () => {
  const s = testing.state();
  const p = db.insert_profile(s.db(), "p", [], null);
  const task = db.insert_task(s.db(), new_task(p.id, "Fix login", "The login page 500s", "in_review"));
  TEST.spent = calls.Spent_claude({
    type: "result",
    modelUsage: { "claude-haiku-5-5": { inputTokens: 2, outputTokens: 7, cacheCreationInputTokens: 600, costUSD: 0.0002 } },
  });
  s.add_message(task.id, "user", { text: "Now add a logout button" });
  reply("Add a logout button");
  refresh(s, task.id);
  await settle();
  // A failed one too: the tokens were spent.
  TEST.reply = null;
  s.add_message(task.id, "user", { text: "And a sign-up page" });
  refresh(s, task.id);
  await settle();
  const kept = db
    .all(s.db(), "SELECT purpose, task_id, model, output_tokens, cost_usd FROM call_usage ORDER BY id")
    .map((r) => [r.purpose, r.task_id, r.model, r.output_tokens, r.cost_usd]);
  const row = ["title", task.id, "claude-haiku-5-5", 7, 0.0002];
  assert.deepEqual(kept, [row, row]);
});

test("placeholder_uses_first_line", () => {
  assert.equal(placeholder("\n# Fix the login bug\n\nDetails"), "Fix the login bug");
  assert.equal(placeholder("   "), "New task");
  const long = placeholder("for a new task, just have the describe task dialog, and use haiku with claude -p to generate the title");
  assert.ok(long.endsWith("…") && Array.from(long).length <= 61, long);
});

test("placeholder_names_attachments", () => {
  const one = "Attached files:\n- /data/attachments/0123456789abcdef0123456789abcdef/shot.png";
  assert.equal(placeholder(one), "Attached shot.png");
  assert.equal(placeholder(`${one}\n- /data/attachments/fedcba9876543210fedcba9876543210/log.txt`), "Attached shot.png and 1 more");
  assert.equal(placeholder(`Look at this\n\n${one}`), "Look at this");
});

test("clean_strips_decoration", () => {
  assert.equal(clean('"Generate task titles with Haiku."\n'), "Generate task titles with Haiku");
  assert.equal(clean("Title: **Add login**"), "Add login");
  assert.equal(clean("Wire the flow to call `claude -p` for the title."), "Wire the flow to call `claude -p` for the title");
});
