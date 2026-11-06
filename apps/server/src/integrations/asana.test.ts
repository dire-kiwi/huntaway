// Port of the tests in server/src/integrations/asana.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { AsanaError, label, me, search, task_gid, type AsanaTask } from "./asana.ts";
import { TOKEN, fake } from "./asana/tests.ts";

test("searches_every_workspace_and_finds_tasks_by_url", async () => {
  await fake();
  const user = await me(TOKEN);
  assert.deepEqual([label(user), user.workspaces], ["Ivy (ivy@example.com)", ["100", "200"]]);
  await assert.rejects(me("nope"), (e: any) => e instanceof AsanaError && e.kind === "Unauthorized");
  // Open tasks first, each workspace's in Asana's order.
  const names = (ts: AsanaTask[]) => ts.map((t) => t.name);
  assert.deepEqual(names(await search(TOKEN, "")), ["Fix signup", "Write docs", "Fix login"]);
  assert.deepEqual(names(await search(TOKEN, " fix ")), ["Fix signup", "Fix login"]);
  const found = await search(TOKEN, "https://app.asana.com/0/1/1002/f");
  assert.equal(found.length, 1);
  const t = found[0];
  assert.deepEqual([t.gid, t.url, t.notes], ["1002", "https://app.asana.com/0/1/1002", "Notes for Fix signup"]);
  assert.deepEqual([t.assignee, t.projects, t.workspace], ["Ivy", ["Web"], "Acme"]);
  await assert.rejects(search(TOKEN, "https://app.asana.com/0/1/5555"), (e: any) => e instanceof AsanaError && e.kind === "NotFound");
});

test("reads_task_urls", () => {
  assert.equal(task_gid("https://app.asana.com/0/1200000000000001/1200000000000002"), "1200000000000002");
  assert.equal(task_gid("https://app.asana.com/0/1200000000000001/1200000000000002/f"), "1200000000000002");
  assert.equal(task_gid("https://app.asana.com/0/0/1200000000000002?focus=true"), "1200000000000002");
  assert.equal(task_gid("https://app.asana.com/1/1111111111/project/2222222222/task/3333333333"), "3333333333");
  assert.equal(task_gid("https://app.asana.com/1/1111111111/task/3333333333?focus=true"), "3333333333");
  assert.equal(task_gid("1200000000000002"), "1200000000000002");
  // A project, not a task.
  assert.equal(task_gid("https://app.asana.com/0/1200000000000001"), null);
  assert.equal(task_gid("https://app.asana.com/1/1111111111/project/2222222222/list"), null);
  // Words and short numbers are searched for.
  assert.equal(task_gid("fix login"), null);
  assert.equal(task_gid("2024"), null);
  assert.equal(task_gid("https://example.com/0/1/2"), null);
});
