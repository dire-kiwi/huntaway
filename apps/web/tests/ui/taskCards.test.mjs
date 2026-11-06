import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
const later = (s) => new Date(Date.now() + s * 1000).toISOString();
const review = (state, issues = []) => ({ thread_id: "none", state, head: null, summary: "summary", issues, fixes: 0, updated_at: ago(60) });

// What the cards get on top of what the server says: agents can't run here, so their states are made up.
const STATES = {
  "Card: subproject at work": { subproject: true, running: true, run_started_at: ago(4140), starred: true, remind_at: later(7200), branch: "ia/a", cost_usd: 4.12 },
  "Card: waiting agent": { running: true, run_started_at: ago(1380), agent_wait: { reason: "Waiting for CI on the release branch to finish", since: ago(600), until: later(1800) } },
  "Card: needs you": { status: "needs_attention", attention_reason: "Which of the two layouts should the sidebar use? I need your call before I go on.", starred: true, remind_at: later(86400) },
  "Card: reviewed": { status: "in_review", review: review("issues", Array(12).fill("an issue")), preview_url: "http://127.0.0.1:1/", pr_url: "https://github.com/o/r/pull/7", branch: "ia/b" },
  "Card: everything": { status: "in_review", labels: ["plan"], starred: true, remind_at: later(3 * 3600), review: review("running"), depends: true, branch: "ia/c", cost_usd: 12.75 },
  // Agents stopped on a permission prompt: still running, and needing you.
  "Card: approval while working": { status: "needs_attention", running: true, run_started_at: ago(600), attention_reason: "Allow Bash: cargo test?" },
  "Card: approval while merging": { status: "needs_attention", running: true, merging: true, run_started_at: ago(900), attention_reason: "Allow Bash: git push?" },
  "Card: won't fix": { status: "done", resolution: "wont_fix", done_at: ago(3600), last_activity_at: ago(3600) },
};

// IA-150: a card's status bar is one line at any column width, with the key and the state whole, and the badges'
// words come back once the card is 280px wide. A subproject's card shows its progress along its bottom edge.
test("task cards keep their status bar on one line, and show words once there's room", async () => {
  for (const title of Object.keys(STATES)) await server.api("POST", `/projects/${project.id}/tasks`, { title, status: "in_progress" });
  const dep = await server.api("POST", `/projects/${project.id}/tasks`, { title: "Card: dependency", status: "todo" });
  await withBrowser(server, { allowErrors: [/127\.0\.0\.1:1\//] }, async (ui) => {
    const { page } = ui;
    let sub;
    await page.route(/\/projects\/[^/]+\/tasks\?kind=task$/, async (route) => {
      const res = await route.fetch();
      const tasks = await res.json();
      for (const t of tasks) {
        const s = STATES[t.title];
        if (s) Object.assign(t, s, s.depends ? { depends_on: [dep.id] } : {});
        if (t.title === "Card: subproject at work") sub = t;
      }
      // Its tasks: 2 of 8 done.
      for (let i = 0; i < 8; i++) tasks.push({ ...sub, id: `sub-task-${i}`, number: 900 + i, title: `Sub task ${i}`, subproject: false, parent_id: sub.id, status: i < 2 ? "done" : "todo", running: false });
      await route.fulfill({ response: res, json: tasks });
    });
    const rows = () =>
      page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll("[data-task]")].map((card) => {
            const row = card.firstElementChild;
            const [key, state] = [row.firstElementChild, row.lastElementChild];
            const whole = (el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= card.getBoundingClientRect().right;
            const title = card.children[1].textContent;
            return [title, { height: row.getBoundingClientRect().height, width: card.getBoundingClientRect().width, key: whole(key), state: whole(state), text: row.innerText.replace(/\s+/g, " "), stateTitle: state.title, stateClass: state.className }];
          }),
        ),
      );

    // The narrowest columns (240px), with every column on screen or not.
    await page.setViewportSize({ width: 1250, height: 900 });
    await ui.run([`goto /p/${project.id}`, "wait Card: everything", "wait Card: won't fix"]);
    let cards = await rows();
    for (const title of [...Object.keys(STATES), "Card: dependency"]) {
      const c = cards[title];
      assert.ok(c, `no card for ${title}`);
      assert.ok(c.width < 280, `${title}: ${c.width}px wide`);
      assert.ok(c.height <= 18, `${title}: its status bar is ${c.height}px high: ${c.text}`);
      assert.ok(c.key && c.state, `${title}: its key or state is cut off: ${c.text}`);
    }
    assert.match(cards["Card: subproject at work"].text, /2\/8(?! done)/);
    assert.match(cards["Card: reviewed"].text, /12(?! issues)/);
    assert.doesNotMatch(cards["Card: won't fix"].text, /Won't fix/);
    // The state: needing you before the agent's run, which still shows how long it's been going.
    const state = (title) => [cards[title].stateTitle, cards[title].stateClass, cards[title].text];
    assert.match(state("Card: needs you")[0], /^Needs your input · /);
    for (const [title, run] of [["Card: approval while working", /working since/], ["Card: approval while merging", /merging since/]]) {
      const [tip, cls, text] = state(title);
      assert.match(tip, /^Needs your input · /, title);
      assert.match(tip, run, title);
      assert.match(cls, /text-st-attention/, title);
      assert.match(text, /\d+m \d\ds$/, title);
    }
    assert.match(state("Card: subproject at work")[0], /^Working since/);
    assert.match(state("Card: subproject at work")[1], /text-st-progress/);
    assert.match(state("Card: waiting agent")[0], /^Waiting for CI/);
    // The subproject's progress, along its bottom edge: a quarter done.
    const bar = page.locator("[data-task] [title='2 of 8 tasks done'] > div");
    assert.equal(await bar.evaluate((el) => el.style.width), "25%");

    // Wide columns: the words are back.
    await page.setViewportSize({ width: 2700, height: 900 });
    await page.waitForFunction(() => document.querySelector("[data-task]").getBoundingClientRect().width >= 280);
    cards = await rows();
    assert.match(cards["Card: subproject at work"].text, /2\/8 done/);
    assert.match(cards["Card: reviewed"].text, /12 issues/);
    assert.match(cards["Card: won't fix"].text, /Won't fix · 1h ago/);
    assert.match(cards["Card: everything"].text, /plan.*-\d+.*reviewing/);
    for (const [title, c] of Object.entries(cards)) assert.ok(c.height <= 18, `${title}: its status bar is ${c.height}px high: ${c.text}`);
  });
});
