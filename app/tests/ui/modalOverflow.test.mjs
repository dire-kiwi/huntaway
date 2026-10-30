import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

/** Whether `name`'s button in the dialog is inside the window, top to bottom. */
const inView = (page, name) =>
  page
    .getByRole("dialog")
    .getByRole("button", { name })
    .evaluate((b) => {
      const r = b.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    });

// HA-24: a dialog taller than the window ran off its bottom, with no way to scroll to its buttons. It fits the window
// now: its fields scroll, and its buttons stay at its bottom.
test("a dialog taller than the window keeps its buttons in view", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run(["size 1200x450", `goto /p/${project.id}`, "click New task", "wait [role=dialog]"]);
    assert.ok(await inView(page, /^Create task/), "the new task dialog's Create button is in the window");
    await ui.run(["click Cancel", "gone [role=dialog]"]);

    await ui.run(["size 1200x600", `goto /p/${project.id}/settings/automations`, "click New automation", "wait Add automation"]);
    const body = page.getByRole("dialog").locator(".overflow-y-auto").first();
    const { scrollHeight, clientHeight } = await body.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    assert.ok(scrollHeight > clientHeight, `the automation dialog's fields scroll (${scrollHeight} > ${clientHeight})`);
    assert.ok(await inView(page, "Add automation"), "its Add button is in the window with the fields at the top");
    await body.evaluate((el) => (el.scrollTop = el.scrollHeight));
    assert.ok(await inView(page, "Add automation"), "and with them at the bottom");

    // And it still saves from there.
    await ui.run([
      "click Weekly dependency update",
      "type Nightly check",
      "click Update dependencies ({{date}})",
      "type Check the nightly build",
      "click Add automation",
      "gone [role=dialog]",
    ]);
    await ui.run(["wait Nightly check"]);
    assert.match(JSON.stringify(await server.api("GET", `/projects/${project.id}/automations`)), /"name":"Nightly check"/, "the automation was saved");
  });
});

// The new task editor's completion list hung past the dialog's bottom edge, and the dialog's scrolling body cut it off.
test("the new task editor's completion list isn't clipped by the dialog", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([`goto /p/${project.id}`, "click New task", "wait [role=dialog]"]);
    await page.keyboard.type("one\ntwo\nthree\nfour\nfive\nsix\nseven\n#");
    await ui.run(["wait [role=listbox]"]);
    const shown = () =>
      page.getByRole("listbox").evaluate((l) => {
        const last = [...l.querySelectorAll("[role=option]")].at(-1);
        const r = last.getBoundingClientRect();
        // On top where it is (not under the dialog's clipping), and inside the window.
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { inWindow: r.top >= 0 && r.bottom <= window.innerHeight, onTop: !!hit && last.contains(hit), count: l.querySelectorAll("[role=option]").length };
      });
    let s = await shown();
    assert.ok(s.count > 1, `options listed (${s.count})`);
    assert.ok(s.inWindow && s.onTop, `the last option shows: ${JSON.stringify(s)}`);

    // With little room under the caret it opens above it, and the arrow keys still pick from it.
    await ui.run(["size 1200x480"]);
    // It moves on the window's resize event, which can come after the resize step returns.
    await page.waitForFunction(() => document.querySelector("[role=listbox]").getBoundingClientRect().bottom <= window.innerHeight, null, { timeout: 2000 }).catch(() => {});
    s = await shown();
    assert.ok(s.inWindow && s.onTop, `the last option shows in a short window: ${JSON.stringify(s)}`);
    await page.keyboard.press("ArrowUp");
    const lit = await page.getByRole("listbox").evaluate((l) => {
      const o = l.querySelector("[aria-selected=true]");
      const r = o.getBoundingClientRect();
      const lr = l.getBoundingClientRect();
      return { last: o === [...l.querySelectorAll("[role=option]")].at(-1), visible: r.top >= lr.top && r.bottom <= lr.bottom + 1 };
    });
    assert.ok(lit.last && lit.visible, `ArrowUp from the first highlights the last option, in view: ${JSON.stringify(lit)}`);
  });
});
