import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { forkedSkillMessages } from "../fixtures/forkedSkill.mjs";
import { convert, Translator } from "../../../server/src/threads/translate.ts";
import { demoProject, routeThread, SEQ, startServer, withBrowser } from "./harness.mjs";

let server, project;
beforeAll(async () => {
  server = startServer();
  project = await demoProject(server);
});
afterAll(() => server?.stop());

// IA-173: replay the Skill/local_agent shape from ODS-9, as a long thread's items (a window and earlier pages).
test("an older review's forked Skill opens from Agents with its transcript and report", async () => {
  const parent = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Work under review" });
  const thread = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Review of work" });
  const messages = forkedSkillMessages(thread.id);
  messages.find((m) => m.kind === "permission").data.status = "allowed";
  // More than a window's 300 items after it.
  for (let n = 1; n <= 320; n++)
    messages.push({
      id: messages.length + 1,
      task_id: thread.id,
      kind: "claude",
      created_at: new Date(n * 1000).toISOString(),
      data: { type: "assistant", message: { content: [{ type: "text", text: `Review follow-up ${n}.` }] } },
    });
  // A review thread of the parent task.
  execFileSync("python3", [
    "-c",
    `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("update tasks set kind='review', parent_id=? where id=?", (sys.argv[2], sys.argv[3]))
c.commit()
`,
    `${server.dataDir}/huntaway-2.db`,
    parent.id,
    thread.id,
  ]);

  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await routeThread(page, thread.id, messages);
    await ui.run([`goto /t/${thread.id}`, "wait css=h1:text-is('Review')", "wait Review follow-up 320.", "wait Load earlier messages"]);
    assert.equal(await page.getByText("Main reviewer summary.", { exact: true }).count(), 0, "the Skill's launch is before the window");
    assert.match(await page.getByTitle("Subagents in this thread").innerText(), /1 done/);
    await ui.run(["click Subagents in this thread", "click css=.shadow-xl button:has-text('/code-review')", "wait Show in thread"]);
    await ui.run(["wait Review PR 139 for correctness bugs.", "wait git diff main...HEAD", "wait Permission for Bash", "wait No runtime bugs found."]);
    await ui.run(["click git diff main...HEAD", "wait The reviewed diff.", "gone Review follow-up 320."]);
    await ui.run(["click Show in thread"]);
    await ui.run(["gone Show in thread", "wait Review follow-up 320.", "wait No runtime bugs found."]);
    await page.getByRole("button", { name: "Open subagent thread", exact: true }).waitFor();
  });
});

test("a streamed Skill launch becomes a running subagent, then completes with its report", async () => {
  const task = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Live forked Skill", status: "in_review" });
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    // An empty thread, which the messages below come to as its live events.
    await routeThread(page, task.id, []);
    let socket;
    await page.routeWebSocket(/\/api\/ws/, (ws) => {
      socket = ws;
      ws.connectToServer();
    });
    await ui.run([`goto /t/${task.id}`, "click Thread", "wait No agent has worked on this yet"]);
    // Its (empty) window has loaded (routeThread serves it as a task on items), and it starts.
    await ui.run(["wait css=[data-thread=items]"]);
    socket.send(JSON.stringify({ type: "task", task: { ...task, running: true, thread_source: "items" } }));
    const messages = forkedSkillMessages(task.id);
    // Each message as the thread events the server writes for it, numbered on from the window's seq.
    const translator = new Translator();
    let seq = SEQ;
    const send = (m) => {
      for (const e of convert([m], { from: translator, finished: false }).events)
        socket.send(JSON.stringify({ type: "thread_event", task_id: task.id, event: { ...e, thread_id: task.id, seq: ++seq } }));
    };
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
