import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project;
before(async () => {
  server = startServer();
  project = await demoProject(server);
});
after(() => server?.stop());

// HA-12: closing the editor of a webhook it had just made blanked the page (an effect returned scrollIntoView's promise).
test("a new webhook shows its URL and secret, closes cleanly, and its deliveries show live", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui;
    await ui.run([
      `goto /p/${project.id}/settings`,
      "click New automation",
      "click Weekly dependency update",
      "type Issue triage",
      "click From a webhook",
      "click Events, e.g. issues",
      "type issues",
      "click Generate",
      "click Triage: {{body.issue.title}}",
      "type Triage: {{body.issue.title}}",
      "click Add automation",
      "wait [data-testid=webhook-url]",
    ]);
    const dialog = page.getByRole("dialog");
    const url = await dialog.getByRole("textbox", { name: "Webhook URL", exact: true }).inputValue();
    assert.match(url, new RegExp(`^${server.url}/api/hooks/[\\w-]+/\\w+$`));
    // The secret it was given is still there to copy until the dialog closes.
    const secret = await dialog.getByRole("textbox", { name: "Secret", exact: true }).inputValue();
    assert.match(secret, /^[0-9a-f]{40}$/);
    await ui.run(["click [role=dialog] >> text=Done", "gone [role=dialog]", "wait Issue triage", "wait No deliveries yet"]);

    const deliver = (body, signed) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          ...(signed ? { "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` } : {}),
        },
        body,
      });
    const body = JSON.stringify({ action: "opened", issue: { title: "Crash on save" } });
    assert.equal((await deliver(body, false)).status, 401);
    assert.equal((await deliver(body, true)).status, 202);
    // The list follows the deliveries as they come.
    await ui.run(["wait Ran", "click Last delivery", "wait Rejected", "wait Triage: Crash on save"]);
  });
});

test("an automation's editor keeps what it was saved with", async () => {
  const made = await server.api("POST", `/projects/${project.id}/automations`, {
    name: "Weekly",
    trigger: {
      kind: "webhook",
      filters: [
        { path: "action", op: "in", value: ["opened", "labeled"] },
        { path: "body.sender.login", op: "not_equals", value: "dependabot" },
      ],
      coalesce_seconds: 90,
      coalesce_key: "{{body.issue.number}}",
    },
    action: { kind: "create_task", title: "T {{body.issue.title}}", description: "D", status: "backlog", effort: "high" },
  });
  const sched = await server.api("POST", `/projects/${project.id}/automations`, {
    name: "Mondays",
    trigger: { kind: "daily", time: "08:30", weekdays: ["mon", "thu"] },
    action: { kind: "create_task", title: "Plan the week", start: false },
  });
  await withBrowser(server, {}, async (ui) => {
    for (const a of [made, sched]) {
      await ui.run([`goto /p/${project.id}/settings`, `click ${a.name}`, `wait Edit ${a.name}`, "click Save automation", "gone [role=dialog]"]);
      const after = await server.api("GET", `/automations/${a.id}`);
      assert.deepEqual(after.trigger, a.trigger, a.name);
      assert.deepEqual(after.action, a.action, a.name);
    }
    // An interval in hours shows as hours.
    await server.api("PATCH", `/automations/${sched.id}`, { trigger: { kind: "interval", every_minutes: 360 } });
    await ui.run([`goto /p/${project.id}/settings`, "wait Every 6 hours", "click Mondays", "wait Edit Mondays"]);
    assert.equal(await ui.page.getByRole("spinbutton", { name: "Every" }).inputValue(), "6");
    assert.equal(await ui.page.getByRole("combobox", { name: "Unit" }).inputValue(), "hours");
  });
});

// HA-19: a failed "Make a new URL" was an unhandled rejection, and a secret was trimmed before it was saved, so a
// GitHub secret with a space around it never matched.
test("a webhook's URL that can't be renewed, and a secret with spaces around it, say so", async () => {
  const made = await server.api("POST", `/projects/${project.id}/automations`, {
    name: "Renewed hook",
    trigger: { kind: "webhook" },
    action: { kind: "create_task", title: "x" },
  });
  await withBrowser(server, { allowErrors: [/status of (400|500)/] }, async (ui) => {
    const { page } = ui;
    page.on("dialog", (d) => d.accept());
    await page.route(`**/automations/${made.id}`, (r) =>
      r.request().method() === "PATCH" && r.request().postDataJSON()?.rotate_token
        ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "disk full" }) })
        : r.fallback(),
    );
    await ui.run([`goto /p/${project.id}/settings`, "click Renewed hook", "wait Edit Renewed hook", "click Make a new URL", "wait Couldn't make a new URL: disk full"]);
    assert.equal((await server.api("GET", `/automations/${made.id}`)).hook_path, made.hook_path);

    const secret = page.getByRole("textbox", { name: "Secret", exact: true });
    await secret.fill("s3cret ");
    await ui.run(["click Save automation", "wait can't start or end with spaces"]);
    assert.equal((await server.api("GET", `/automations/${made.id}`)).has_secret, false);
    await secret.fill("s3 cret");
    await ui.run(["click Save automation", "gone [role=dialog]"]);
    const body = "{}";
    const res = await fetch(`${server.url}${made.hook_path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", "s3 cret").update(body).digest("hex")}` },
      body,
    });
    assert.equal(res.status, 202);
  });
});
