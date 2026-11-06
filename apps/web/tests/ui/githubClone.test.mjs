import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startServer, withBrowser } from "./harness.mjs";

let server, profile, clones;
before(async () => {
  server = startServer();
  [profile] = await server.api("GET", "/profiles");
  // The profile clones into a scratch folder, where o/r is cloned already, so adding it needs no gh.
  clones = realpathSync(mkdtempSync(join(tmpdir(), "ia-clones-")));
  for (const name of ["r", "slow", "dev"]) {
    const repo = join(clones, name);
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", `git@github.com:o/${name}.git`]);
  }
  mkdirSync(join(clones, "taken"));
  writeFileSync(join(clones, "taken", "notes.txt"), "mine");
  await server.api("PATCH", `/profiles/${profile.id}`, { clone_dir: clones });
});
after(() => {
  server?.stop();
  if (clones) rmSync(clones, { recursive: true, force: true });
});

const repo = (full_name, extra = {}) => ({
  full_name,
  name: full_name.split("/")[1],
  description: null,
  private: false,
  fork: false,
  archived: false,
  pushed_at: "2026-10-01T00:00:00Z",
  url: `https://github.com/${full_name}`,
  ...extra,
});

// IA-171: Add project's GitHub tab lists the repositories gh can reach (faked here), filters them as you type and adds
// what the search finds, offers OWNER/REPO typed in, and clones the one picked into the profile's clone folder.
test("adds a project from GitHub into the profile's clone folder", async () => {
  // The folder that's in the way is a 400.
  await withBrowser(server, { allowErrors: [/status of 400 .*\/projects\/clone\)$/] }, async (ui) => {
    const { page } = ui;
    const searches = [];
    await page.route(/\/github-repos(\?|$)/, (route) => {
      const q = new URL(route.request().url()).searchParams.get("q");
      if (q) searches.push(q);
      const repos = q ? [repo("acme/search-hit"), repo("o/r")] : [repo("o/r", { private: true, description: "The one" }), repo("me/taken"), repo("me/website"), repo("o/slow")];
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ account: "me", repos, error: null }) });
    });
    await ui.run(["goto /", "click [title='Add project']", "wait Repository folder", "click role=radio[name=/GitHub/]", "wait me/website"]);
    assert.match(await page.locator("[data-modal]").innerText(), /As me \(gh's active account\)/);

    // What's typed filters the list at once, and what the search finds comes after.
    const shown = () => page.locator("[role=option]").evaluateAll((els) => els.map((e) => e.dataset.repo));
    await ui.run(["type o/r", "gone me/website", "wait acme/search-hit"]);
    assert.deepEqual(await shown(), ["o/r", "acme/search-hit"]);
    assert.deepEqual(searches, ["o/r"], "one search once typing stops");
    // Any other repository can be typed in, or pasted as a URL.
    await ui.run(["press Control+a", "type https://github.com/someone/else/tree/main", "wait Clone someone/else"]);

    // A folder that's in the way is turned down, and the dialog stays with the error.
    await ui.run(["press Control+a", "type taken", "click [data-repo='me/taken']", "wait Clone me/taken into"]);
    assert.equal(await page.locator("[data-modal] input.font-mono").inputValue(), `${clones}/taken`);
    await ui.run(["click role=button[name='Clone and add project']", "wait already exists"]);

    // The clone of o/r that's there is added as it is, named after its folder.
    await ui.run(["click [placeholder='Search, or OWNER/REPO']", "press Control+a", "type o/r", "click [data-repo='o/r']"]);
    assert.equal(await page.locator("[data-modal] input.font-mono").inputValue(), `${clones}/r`);
    await ui.run(["click role=button[name='Clone and add project']", "gone [data-modal]"]);
    const added = (await server.api("GET", `/profiles/${profile.id}/projects`)).find((p) => p.name === "r");
    assert.equal(added?.repo_path, `${clones}/r`);
    await ui.run([`assert location.pathname === '/p/${added.id}'`, `wait css=aside >> role=button[name=/${added.key} r/]`]);

    // The dialog opens on the GitHub tab next time.
    await ui.run(["click [title='Add project']", "wait me/website", "assert document.querySelector('[role=radio][aria-checked=true]').textContent.includes('GitHub')"]);

    // Closed while it clones, the project is still added, but the board stays where it is.
    await page.route("**/projects/clone", async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      await route.continue();
    });
    await ui.run(["click [data-repo='o/slow']", "click role=button[name='Clone and add project']", "wait Cloning…", "press Escape", "gone [data-modal]"]);
    await ui.run(["wait css=aside >> text=slow", `assert location.pathname === '/p/${added.id}'`]);
  });
});

const appDir = fileURLToPath(new URL("../..", import.meta.url));

/** The UI's Vite dev server, on `server`'s API: its React runs in StrictMode, which mounts components twice. */
async function startDevServer(server) {
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const vite = spawn(join(appDir, "node_modules/.bin/vite"), ["--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: appDir,
    env: { ...process.env, IA_SERVER: server.url },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  await new Promise((resolve, reject) => {
    // Killed if it doesn't start, or the test's process would wait for it forever.
    const timer = setTimeout(() => (vite.kill(), reject(new Error(`vite didn't start:\n${log}`))), 30000);
    const read = (d) => {
      log += d;
      // With $CI set (as on GitHub's runners) Vite's colours are on, and it prints the port in bold.
      if (log.replace(/\x1b\[[0-9;]*m/g, "").includes(`127.0.0.1:${port}`)) clearTimeout(timer), resolve();
    };
    vite.stdout.on("data", read);
    vite.stderr.on("data", read);
    vite.on("exit", (code) => (clearTimeout(timer), reject(new Error(`vite exited with ${code}:\n${log}`))));
  });
  return { url: `http://127.0.0.1:${port}`, stop: () => vite.kill() };
}

// IA-171 review: in development StrictMode mounts the dialog twice, which mustn't leave it taking itself for closed (and
// so neither closing nor showing errors once the clone is done).
test("adds a project from GitHub with the dev server's StrictMode", async () => {
  const dev = await startDevServer(server);
  try {
    await withBrowser({ ...server, url: dev.url }, { timeout: 20000 }, async (ui) => {
      const { page } = ui;
      await page.route(/\/github-repos(\?|$)/, (route) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify({ account: "me", repos: [repo("o/dev")], error: null }) }),
      );
      await ui.run(["goto /", "click [title='Add project']", "click role=radio[name=/GitHub/]", "click [data-repo='o/dev']"]);
      await ui.run(["click role=button[name='Clone and add project']", "gone [data-modal]"]);
      const added = (await server.api("GET", `/profiles/${profile.id}/projects`)).find((p) => p.name === "dev");
      await ui.run([`assert location.pathname === '/p/${added.id}'`]);
    });
  } finally {
    dev.stop();
  }
});
