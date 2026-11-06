import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, test } from "vite-plus/test";
import { startServer, withBrowser } from "./harness.mjs";

// The new database file is on by default since HA-222; this file says so for its server (test-server.sh keeps it for restarts).
process.env.IA_NEW_DB_FILE = "1";

let server;
beforeAll(() => {
  server = startServer();
});
afterAll(() => server?.stop());

// HA-153 (HA-213 in the TypeScript server): Settings → Server says which file the database is in, and when an older build
// has used the data dir since, warns and offers Copy again, which asks before it restarts.
test("Settings → Server warns when an older build has used the data dir, and asks before copying again", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run(["goto /settings", "wait Database huntaway-2.db"]);
    assert.equal(await ui.page.getByText("Copy again").count(), 0, "nothing to copy on a fresh data dir");

    // An older build makes its own huntaway.db.
    writeFileSync(`${server.dataDir}/huntaway.db`, "");
    assert.equal((await server.api("GET", "/admin/server")).database.older_changed, "huntaway.db");
    await ui.run(["goto /settings", "wait has changed since huntaway-2.db was made", "click Copy again", "wait Copy again & restart"]);
    assert.match(await ui.page.getByRole("dialog").innerText(), /is discarded/);
    await ui.run(["click Close", "gone Copy again & restart"]);
    // Nothing was asked of the next start.
    assert.equal((await server.api("GET", "/admin/server")).restart, null);
  });
});
