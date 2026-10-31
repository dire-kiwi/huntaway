import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { gitRepo, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  const repo = `${server.dataDir}/shop`;
  gitRepo(repo);
  const [profile] = await server.api("GET", "/profiles");
  project = await server.api("POST", `/profiles/${profile.id}/projects`, { name: "Shop", repo_path: repo, key: "SHOP" });
  // Nothing reads its pull requests in the background: neither watching them in review nor Done when merged.
  await server.api("PATCH", `/projects/${project.id}`, { watch_pull_requests: "off", done_when_merged: false });
});
after(() => server?.stop());

const PR = "https://github.com/o/r/pull/7";

/** A task with pull request #7, whose checks the board shows as `checks` (null: never read). */
async function taskWith(page, title, checks) {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title });
  await server.api("PATCH", `/tasks/${task.id}`, { pr_url: PR });
  // The host only keeps what a read of GitHub found, which a test server can't make: the board is given it.
  await page.route(new RegExp(`/api/h/[^/]+/projects/${project.id}/tasks(\\?|$)`), async (route) => {
    const res = await route.fetch();
    const tasks = (await res.json()).map((t) => (t.id === task.id ? { ...t, pr_checks: checks } : t));
    await route.fulfill({ response: res, json: tasks });
  });
  // Fix broken checks reads GitHub afresh, which says nothing failed.
  const calls = [];
  await page.route(new RegExp(`/api/h/[^/]+/tasks/${task.id}/fix_checks$`), (route) => {
    calls.push(route.request().method());
    return route.fulfill({ status: 409, json: { error: "no checks have failed on o/r#7's head commit" } });
  });
  return { task, calls };
}

const snapshot = (outcome, failed = []) => ({ url: PR, head: "c0ffee1234", outcome, failed, more_failed: 0, pending: 0, passed: 2, since: new Date().toISOString() });

// HA-53 review: the button was only there once a background read had found failures, so a pull request no read
// watches (or one whose last read was before its checks failed) had no way to send them to the agent.
for (const [name, checks, shown] of [
  ["never read", null, "Reads the pull request's checks now"],
  ["last read when they passed", snapshot("passed"), "Checks passed on c0ffee1 as last read"],
]) {
  test(`Fix broken checks is there for a pull request ${name}, and says when nothing failed`, async () => {
    await withBrowser(server, { allowErrors: [/status of 409/] }, async (ui) => {
      const { task, calls } = await taskWith(ui.page, `Unwatched, ${name}`, checks);
      await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Details", `wait ${shown}`]);
      assert.equal(await ui.page.locator("[title*='checks failed']").count(), 0, "no failed checks mark");
      await ui.run(["click Fix broken checks", "wait no checks have failed on o/r#7's head commit"]);
      assert.deepEqual(calls, ["POST"]);
    });
  });
}

test("failed checks from the last read are listed with links to their runs, and marked on the card", async () => {
  await withBrowser(server, {}, async (ui) => {
    const failed = [{ name: "Tests / server", conclusion: "failure", url: "https://github.com/o/r/actions/runs/9/job/42" }];
    const { task } = await taskWith(ui.page, "Failing", snapshot("failed", failed));
    await ui.run([`goto /p/${project.id}?task=${task.id}`, "click Details", "wait 1 check failed on", "wait Fix broken checks"]);
    assert.equal(await ui.page.getByRole("link", { name: "Tests / server" }).getAttribute("href"), failed[0].url);
    assert.equal(await ui.page.locator(`[data-task='${task.id}'] [title^='1 check failed on #7']`).count(), 1, "the card's mark");
  });
});
