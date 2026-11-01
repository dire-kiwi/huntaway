import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import { forkedSkillMessages } from "../fixtures/forkedSkill.mjs";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

// IA-173: replay the Skill/local_agent shape from ODS-9, through the real paged messages API.
test("an older review's forked Skill opens from Agents with its transcript and report", async () => {
  const parent = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Work under review" });
  const thread = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Review of work" });
  const messages = forkedSkillMessages(thread.id);
  messages.find((m) => m.kind === "permission").data.status = "allowed";
  for (let n = 1; n <= 120; n++) messages.push({ task_id: thread.id, kind: "claude", created_at: new Date(n * 1000).toISOString(),
    data: { type: "assistant", message: { content: [{ type: "text", text: `Review follow-up ${n}.` }] } } });
  execFileSync("python3", ["-c", `
import json, sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("update tasks set kind='review', parent_id=? where id=?", (sys.argv[2], sys.argv[3]))
for m in json.load(sys.stdin):
 c.execute("insert into messages (task_id,kind,data,created_at) values (?,?,?,?)", (m['task_id'], m['kind'], json.dumps(m['data'], separators=(',', ':')), m['created_at']))
c.commit()
`, `${server.dataDir}/huntaway.db`, parent.id, thread.id], { input: JSON.stringify(messages) });

  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /t/${thread.id}`, "wait css=h1:text-is('Review')", "wait Review follow-up 120.", "wait Load earlier messages"]);
    assert.equal(await page.getByText("Main reviewer summary.", { exact: true }).count(), 0, "the Skill's launch is in an older page");
    assert.match(await page.getByTitle("Subagents in this thread").innerText(), /1 done/);
    await ui.run(["click Subagents in this thread", "click css=.shadow-xl button:has-text('/code-review')", "wait Show in thread"]);
    await ui.run(["wait Review PR 139 for correctness bugs.", "wait git diff main...HEAD", "wait Permission for Bash", "wait No runtime bugs found."]);
    await ui.run(["click git diff main...HEAD", "wait The reviewed diff.", "gone Review follow-up 120."]);
    await ui.run(["click Show in thread"]);
    await ui.run(["gone Show in thread", "wait Review follow-up 120.", "wait No runtime bugs found."]);
    await page.getByRole("button", { name: "Open subagent thread", exact: true }).waitFor();
  });
});

test("a streamed Skill launch becomes a running subagent, then completes with its report", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Live forked Skill", status: "in_review" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    let socket;
    await page.routeWebSocket(/\/api\/ws/, (ws) => { socket = ws; ws.connectToServer(); });
    await ui.run([`goto /t/${task.id}`, "click Thread", "wait No agent has worked on this yet"]);
    socket.send(JSON.stringify({ type: "task", task: { ...task, running: true } }));
    const messages = forkedSkillMessages(task.id);
    const send = (m) => socket.send(JSON.stringify({ type: "message", task_id: task.id, message: { ...m, id: m.id + 100000 } }));
    send(messages[0]);
    await ui.run(["wait css=[data-tool-row] button:has-text('Skill')", "gone Subagents in this thread"]);
    send(messages[1]);
    await ui.run(["wait Subagents in this thread", "wait /code-review"]);
    assert.match(await page.getByTitle("Subagents in this thread").innerText(), /1 running/);
    for (const m of messages.slice(2, 5)) send(m);
    await ui.run(["wait from /code-review", "click Open subagent thread", "wait needs approval", "wait git diff main...HEAD"]);
    for (const m of messages.slice(5)) send(m);
    await ui.run(["wait No runtime bugs found."]);
    assert.match(await page.getByTitle("Subagents in this thread").innerText(), /1 done/);
    await ui.run(["press Escape", "wait Main reviewer summary.", "gone Show in thread"]);
  });
});
