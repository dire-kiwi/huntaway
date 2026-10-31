import assert from "node:assert/strict";
import { test } from "node:test";

// The router listens to the window as it loads.
globalThis.window = { addEventListener() {}, location: { pathname: "/", search: "", hash: "" }, history: { pushState() {}, replaceState() {} } };
const { href, parse } = await import("../src/router.ts");
const { unauthorizedHere } = await import("../src/api.ts");

test("routes round-trip through their paths", () => {
  for (const route of [
    { name: "profile", profile: "work" },
    { name: "board", projectId: "p1" },
    { name: "projectSettings", projectId: "p1", tab: "agents" },
    { name: "task", taskId: "t1" },
    { name: "subproject", taskId: "t1" },
    { name: "group", hostId: "h1", group: "Sites & apps" },
    { name: "host", hostId: "h1" },
    { name: "settings" },
    { name: "analytics" },
  ]) {
    assert.deepEqual(parse(new URL(href(route), "http://x").pathname), route, href(route));
  }
});

// HA-32: a malformed escape in a hand-typed or mangled link (a group named "100%" linked as /g/h/100%) was a
// crash in render, with no error boundary to catch it; it's taken as it is instead.
test("a path with a malformed escape still parses", () => {
  assert.deepEqual(parse("/g/h1/100%"), { name: "group", hostId: "h1", group: "100%" });
  assert.deepEqual(parse("/profile/%E0%A4%A"), { name: "profile", profile: "%E0%A4%A" });
  assert.deepEqual(parse("/p/p1/settings/%"), { name: "projectSettings", projectId: "p1", tab: "%" });
  assert.deepEqual(parse("/profile/100%25"), { name: "profile", profile: "100%" });
});

// HA-32: a linked host answering 401 (its token changed since it was linked) signed the user out of the whole board.
test("only this hub's or its own host's 401 means the board's token is wrong", () => {
  assert.equal(unauthorizedHere("/hosts", "local"), true);
  assert.equal(unauthorizedHere("/profiles", null), true);
  assert.equal(unauthorizedHere("/h/local/profiles", "local"), true);
  assert.equal(unauthorizedHere("/h/remote/profiles", "local"), false);
  assert.equal(unauthorizedHere("/h/remote/tasks/t1?x=1", "local"), false);
  // Before the hosts are known, another host's answer is left alone too.
  assert.equal(unauthorizedHere("/h/remote/profiles", null), false);
  assert.equal(unauthorizedHere(`/h/${encodeURIComponent("host one")}/profiles`, "host one"), true);
});
