import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { gate, gitRepo, makeProfile, routeRpc, startServer, success, withBrowser } from "./harness.mjs"

// The old tests/ui/githubClone.test.mjs. The old check answered `GET /github-repos` with `page.route`; this one answers
// `profiles.githubRepos` on the RPC websocket (`routeRpc`), and holds `projects.clone` there for the "closed while it
// clones" case. As before, every repository the first two add is a clone that's in the folder already. Added: one listed
// and cloned through the fake gh (`--fake-gh`, seeded with a repository whose `source` is a folder here).

let server, profile, clones, sources
beforeAll(async () => {
  // The fake gh, so nothing here reaches GitHub: me, with me/fresh to clone from a folder here.
  sources = realpathSync(mkdtempSync(join(tmpdir(), "ia-sources-")))
  const fresh = gitRepo(join(sources, "fresh"))
  const seed = join(sources, "github.json")
  writeFileSync(
    seed,
    JSON.stringify({
      accounts: [{ host: "github.com", login: "me", token: "tok-me", active: true }],
      repos: { "me/fresh": { source: fresh, description: "Cloned for real", pushed_at: "2026-10-02T00:00:00Z" } },
    }),
  )
  process.env["HUNTAWAY_FAKE_GH_SEED"] = seed
  server = startServer("--fake-gh")
  profile = await makeProfile(server, "Default")
  // The profile clones into a scratch folder, where o/r is cloned already, so adding it needs no gh.
  clones = realpathSync(mkdtempSync(join(tmpdir(), "ia-clones-")))
  for (const name of ["r", "slow", "dev"]) {
    const repo = join(clones, name)
    mkdirSync(repo)
    execFileSync("git", ["init", "-q", repo])
    execFileSync("git", ["-C", repo, "remote", "add", "origin", `git@github.com:o/${name}.git`])
  }
  mkdirSync(join(clones, "taken"))
  writeFileSync(join(clones, "taken", "notes.txt"), "mine")
  await server.rpc("profiles.update", { id: profile.id, patch: { clone_dir: clones } })
})
afterAll(() => {
  server?.stop()
  for (const dir of [clones, sources]) if (dir) rmSync(dir, { recursive: true, force: true })
})

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
})

const projects = () => server.rpc("projects.list", { profile_id: profile.id })

// IA-171: Add project's GitHub tab lists the repositories gh can reach (faked here), filters them as you type and adds
// what the search finds, offers OWNER/REPO typed in, and clones the one picked into the profile's clone folder.
test("adds a project from GitHub into the profile's clone folder", async () => {
  await withBrowser(server, {}, async (ui) => {
    const { page } = ui
    const searches = []
    const cloning = gate()
    let holdClones = false
    await routeRpc(page, (request) => {
      if (request.tag === "projects.clone" && holdClones) return cloning.hold()
      if (request.tag !== "profiles.githubRepos") return undefined
      const q = request.payload?.q
      if (q) searches.push(q)
      const repos = q
        ? [repo("acme/search-hit"), repo("o/r")]
        : [repo("o/r", { private: true, description: "The one" }), repo("me/taken"), repo("me/website"), repo("o/slow")]
      return success({ account: "me", repos, error: null })
    })
    await ui.run(["goto /", "click [title='Add project']", "wait Repository folder", "click role=radio[name=/GitHub/]", "wait me/website"])
    assert.match(await page.locator("[data-modal]").innerText(), /As me \(gh's active account\)/)

    // What's typed filters the list at once, and what the search finds comes after.
    const shown = () => page.locator("[role=option]").evaluateAll((els) => els.map((e) => e.dataset.repo))
    await ui.run(["type o/r", "gone me/website", "wait acme/search-hit"])
    assert.deepEqual(await shown(), ["o/r", "acme/search-hit"])
    assert.deepEqual(searches, ["o/r"], "one search once typing stops")
    // Any other repository can be typed in, or pasted as a URL.
    await ui.run(["press Control+a", "type https://github.com/someone/else/tree/main", "wait Clone someone/else"])

    // A folder that's in the way is turned down, and the dialog stays with the error.
    await ui.run(["press Control+a", "type taken", "click [data-repo='me/taken']", "wait Clone me/taken into"])
    assert.equal(await page.locator("[data-modal] input.font-mono").inputValue(), `${clones}/taken`)
    await ui.run(["click role=button[name='Clone and add project']", "wait already exists"])

    // The clone of o/r that's there is added as it is, named after its folder.
    await ui.run(["click [placeholder='Search, or OWNER/REPO']", "press Control+a", "type o/r", "click [data-repo='o/r']"])
    assert.equal(await page.locator("[data-modal] input.font-mono").inputValue(), `${clones}/r`)
    await ui.run(["click role=button[name='Clone and add project']", "gone [data-modal]"])
    const added = (await projects()).find((p) => p.name === "r")
    assert.equal(added?.repo_path, `${clones}/r`)
    await ui.run([`assert location.pathname === '/p/${added.id}'`, `wait css=aside >> role=button[name=/${added.key} r/]`])

    // The dialog opens on the GitHub tab next time.
    await ui.run([
      "click [title='Add project']",
      "wait me/website",
      "assert document.querySelector('[role=radio][aria-checked=true]').textContent.includes('GitHub')",
    ])

    // Closed while it clones, the project is still added, but the board stays where it is.
    holdClones = true
    await ui.run(["click [data-repo='o/slow']", "click role=button[name='Clone and add project']", "wait Cloning…", "press Escape", "gone [data-modal]"])
    cloning.release(undefined)
    await ui.run(["wait css=aside >> text=slow", `assert location.pathname === '/p/${added.id}'`])
  })
})

/** A terminal's colour codes. */
const COLOURS = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")

// gh lists what the account can clone (the fake's me/fresh), and the one picked is cloned with gh into the clone folder.
test("lists and clones a repository through gh", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      "goto /",
      "click [title='Add project']",
      "click role=radio[name=/GitHub/]",
      "wait Cloned for real",
      "click [data-repo='me/fresh']",
      "click role=button[name='Clone and add project']",
      "gone [data-modal]",
    ])
    const added = (await projects()).find((p) => p.name === "fresh")
    assert.equal(added?.repo_path, `${clones}/fresh`)
    assert.equal(execFileSync("git", ["-C", added.repo_path, "remote", "get-url", "origin"], { encoding: "utf8" }).trim(), "https://github.com/me/fresh.git")
    await ui.run([`assert location.pathname === '/p/${added.id}'`])
  })
})

const appDir = fileURLToPath(new URL("../..", import.meta.url))

/** The UI's Vite dev server, on `api`'s API (a test server's): its React runs in StrictMode, which mounts components twice. */
async function startDevServer(api) {
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const free = probe.address().port
      probe.close(() => resolve(free))
    })
  })
  // Vite+'s (`vp dev`): the web app's `vite` is Vite+'s core, which has no command of its own.
  const vite = spawn(join(appDir, "node_modules/.bin/vp"), ["dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: appDir,
    env: { ...process.env, HUNTAWAY_SERVER: api.url },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let log = ""
  await new Promise((resolve, reject) => {
    // Killed if it doesn't start, or the test's process would wait for it forever.
    const timer = setTimeout(() => {
      vite.kill()
      reject(new Error(`vite didn't start:\n${log}`))
    }, 30000)
    const read = (d) => {
      log += d
      // With $CI set (as on GitHub's runners) Vite's colours are on, and it prints the port in bold.
      if (log.replace(COLOURS, "").includes(`127.0.0.1:${port}`)) {
        clearTimeout(timer)
        resolve()
      }
    }
    vite.stdout.on("data", read)
    vite.stderr.on("data", read)
    vite.on("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`vite exited with ${code}:\n${log}`))
    })
    vite.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
  return { url: `http://127.0.0.1:${port}`, stop: () => vite.kill() }
}

// IA-171 review: in development StrictMode mounts the dialog twice, which mustn't leave it taking itself for closed (and
// so neither closing nor showing errors once the clone is done).
test("adds a project from GitHub with the dev server's StrictMode", async () => {
  const dev = await startDevServer(server)
  try {
    await withBrowser({ ...server, url: dev.url }, { timeout: 20000 }, async (ui) => {
      await routeRpc(ui.page, (request) =>
        request.tag === "profiles.githubRepos" ? success({ account: "me", repos: [repo("o/dev")], error: null }) : undefined,
      )
      await ui.run(["goto /", "click [title='Add project']", "click role=radio[name=/GitHub/]", "click [data-repo='o/dev']"])
      await ui.run(["click role=button[name='Clone and add project']", "gone [data-modal]"])
      const added = (await projects()).find((p) => p.name === "dev")
      await ui.run([`assert location.pathname === '/p/${added.id}'`])
    })
  } finally {
    dev.stop()
  }
})
