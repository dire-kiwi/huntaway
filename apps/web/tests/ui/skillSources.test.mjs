import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { demoProject, startServer, withBrowser } from "./harness.mjs";

let server, project, profile, repo;
const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
const skill = (name, description) => {
  mkdirSync(join(repo, "skills", name), { recursive: true });
  writeFileSync(join(repo, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody\n`);
};

before(async () => {
  server = startServer();
  project = await demoProject(server);
  [profile] = await server.api("GET", "/profiles");
  repo = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ia-skill-source-"));
  git("init", "-q", "-b", "main");
  skill("alpha", "The first skill");
  skill("beta", "The second skill");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});
after(() => server?.stop());

// HA-140: skills come from a git repository that's added, updated and removed in Settings, and each is switched on per profile or project.
test("adds a git repository's skills, switches them on and updates and removes the source", async () => {
  // The failed clone is a 502.
  await withBrowser(server, { allowErrors: [/status of 502 .*skill-sources/] }, async (ui) => {
    const { page } = ui;
    await ui.run(["goto /settings", "click Add from git", "type /nonexistent/skills-repo", "press Control+Enter", "wait couldn't clone"]);
    await page.getByRole("textbox").first().fill(repo);
    await ui.run(["press Control+Enter", "gone Add skills from a git repository", "wait The first skill", "wait The second skill"]);
    const added = await server.api("GET", "/agent-tools");
    assert.deepEqual(added.skills.map((s) => s.name), ["alpha", "beta"]);
    assert.equal(added.skill_sources.length, 1);
    assert.deepEqual(added.profile_switches[profile.id] ?? {}, {}, "added skills are off until switched on");

    // The source's chip switches all its skills on for a profile; a source's skills have no Edit or Delete of their own.
    const card = page.locator("div.rounded-xl", { hasText: "All skills on by default in" });
    await card.getByRole("button", { name: profile.name, exact: true }).first().click();
    await ui.run(["wait On by default in"]);
    const on = await server.api("GET", "/agent-tools");
    assert.equal(Object.values(on.profile_switches[profile.id]).filter(Boolean).length, 2);
    assert.equal(await card.getByRole("button", { name: "Edit" }).count(), 0);

    // The project's settings list them, following the profile.
    await ui.run([`goto /p/${project.id}/settings/tools`, "wait alpha"]);
    assert.equal(await page.locator("option", { hasText: "Profile default (on)" }).count(), 2);

    // A skill added to the repository comes with an update, off; one taken out goes.
    skill("gamma", "The third skill");
    git("rm", "-rq", "skills/beta");
    git("add", "-A");
    git("commit", "-q", "-m", "change");
    await ui.run(["goto /settings", "wait The first skill", "click Update", "wait The third skill", "gone The second skill"]);
    const updated = await server.api("GET", "/agent-tools");
    assert.deepEqual(updated.skills.map((s) => s.name), ["alpha", "gamma"]);
    const alpha = updated.skills.find((s) => s.name === "alpha");
    const gamma = updated.skills.find((s) => s.name === "gamma");
    assert.equal(updated.profile_switches[profile.id][alpha.id], true);
    assert.equal(updated.profile_switches[profile.id][gamma.id], undefined);

    await ui.run(["click Remove the source and its skills", "click Remove source", "gone The first skill"]);
    const gone = await server.api("GET", "/agent-tools");
    assert.deepEqual([gone.skills, gone.skill_sources], [[], []]);
  });
});
