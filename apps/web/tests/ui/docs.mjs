// Documents for the browser checks of the Docs page (6.3): the demo's profile, the page's frame, and documents written
// into a test server's database as an agent's `publish_document` would leave them (the board has no way to publish one
// itself, and these servers run no agents), before the page opens them.
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

/** The demo board's profile ("Default", with the "Rollout plan" document `--demo` seeds). */
export const demoProfile = async (server) => (await server.rpc("profiles.list")).find((p) => p.name === "Default")

/** The document page's frame. */
export const reader = (page) => page.frameLocator("iframe[title]").first()

/** The page's path, decoded. */
export const path = (page) => decodeURIComponent(new URL(page.url()).pathname)

/** Waits for the page's path to be `want` (with or without a slash at the end). */
export async function waitPath(page, want) {
  await page.waitForFunction((w) => decodeURIComponent(location.pathname).replace(/\/$/, "") === w.replace(/\/$/, ""), want)
}

/** Writes documents of one version and one page each (`[slug, title, folder]`) for `profile` into `server`'s database. */
export function seedDocs(server, profile, docs) {
  const db = new DatabaseSync(join(server.dataDir, "board.db"))
  try {
    db.exec("PRAGMA busy_timeout = 5000")
    const now = new Date().toISOString()
    for (const [slug, title, folder] of docs) {
      const [id, v] = [randomUUID(), randomUUID()]
      db.prepare("INSERT INTO docs (id, profile_id, slug, title, folder, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(
        id,
        profile.id,
        slug,
        title,
        folder,
        now,
        now,
      )
      db.prepare("INSERT INTO doc_versions (id, doc_id, number, message, created_at) VALUES (?,?,1,'first',?)").run(v, id, now)
      db.prepare("INSERT INTO doc_pages (version_id, path, title, format, source, position) VALUES (?,'index',?,'md',?,0)").run(v, title, `# ${title}\n`)
    }
  } finally {
    db.close()
  }
}
