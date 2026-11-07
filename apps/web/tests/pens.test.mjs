import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "vite-plus/test";

// The app's modules import each other without extensions (and folders by their index.ts), as Vite allows.
const hook = `export async function resolve(spec, ctx, next) {
  if (spec.startsWith(".") && !/\\.[cm]?[jt]sx?$/.test(spec)) {
    try { return await next(spec + ".ts", ctx); } catch {}
    try { return await next(spec + "/index.ts", ctx); } catch {}
  }
  return next(spec, ctx);
}`;
register("data:text/javascript," + encodeURIComponent(hook));
const { inTab, penTabs, tabOf } = await import("../src/pens.ts");

const pen = (host_id, id, name, position, hidden = false, profile_id = "p") => ({ host_id, id, name, position, hidden, profile_id });

// HA-285: a profile's board spans hosts, so its tabs are its pens merged by name, in their order, the board's own host's
// first; a tab is hidden only when each host's pen is.
test("pens on several hosts are one tab each by name", () => {
  const pens = [
    pen("remote", "r1", "today", 1),
    pen("remote", "r2", "Infra", 2),
    pen("local", "l1", "Parked", 2, true),
    pen("local", "l2", "Today", 1),
    pen("remote", "r3", "parked", 3),
    // Another profile's.
    pen("local", "x", "Secret", 0, false, "other"),
  ];
  const tabs = penTabs(pens, new Set(["local:p", "remote:p"]), "local");
  assert.deepEqual(
    tabs.map((t) => [t.name, t.hidden, t.pens.map((p) => p.id)]),
    [
      ["Today", false, ["l2", "r1"]],
      ["Parked", false, ["l1", "r3"]],
      ["Infra", false, ["r2"]],
    ],
  );
  const task = (host_id, pen_id) => ({ host_id, pen_id });
  assert.ok(inTab(tabs[0], task("remote", "r1")));
  assert.ok(inTab(tabs[0], task("local", "l2")));
  // Ids are only a host's own.
  assert.ok(!inTab(tabs[0], task("remote", "l2")));
  assert.equal(tabOf(tabs, task("local", null)), undefined);
  assert.equal(tabOf(tabs, task("remote", "r3")).name, "Parked");
  // Hidden on every host, the tab is hidden.
  const hidden = penTabs([pen("local", "l1", "Parked", 1, true), pen("remote", "r3", "Parked", 1, true)], new Set(["local:p", "remote:p"]), "local");
  assert.equal(hidden[0].hidden, true);
});
