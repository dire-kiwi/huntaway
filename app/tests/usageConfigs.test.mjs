import assert from "node:assert/strict";
import { test } from "node:test";
import { resetsIn, resetsPhrase, usageAlert, usageConfigs } from "../src/usageConfigs.ts";

const config = (host_id, id, show_usage = true) => ({ host_id, id, name: id, config_dir: "", created_at: "", show_usage });
const names = (list) => list.map((c) => `${c.host_id}:${c.id}`);

// IA-130: the sidebar shows usage only for the active profile's configs, and only those turned on.
test("shows the configs the profile uses that show usage", () => {
  const configs = [config("h", "a"), config("h", "b"), config("h", "off", false), config("h2", "a")];
  const profiles = [
    { host_id: "h", id: "p1", name: "personal", claude_config_ids: ["a", "off"] },
    { host_id: "h", id: "p2", name: "work", claude_config_ids: ["b"] },
  ];
  assert.deepEqual(names(usageConfigs(configs, profiles, [], "personal")), ["h:a"], "not another profile's, one that's off, or another host's");
  assert.deepEqual(names(usageConfigs(configs, profiles, [], "work")), ["h:b"]);
  assert.deepEqual(usageConfigs(configs, profiles, [], undefined), []);
});

test("includes configs only a project of the profile picks", () => {
  const configs = [config("h", "a"), config("h", "b"), config("h2", "b")];
  const profiles = [
    { host_id: "h", id: "p1", name: "personal", claude_config_ids: ["a"] },
    { host_id: "h", id: "p2", name: "work", claude_config_ids: [] },
  ];
  const projects = [
    { host_id: "h", profile_id: "p1", claude_config_ids: ["b"] },
    { host_id: "h2", profile_id: "p1", claude_config_ids: ["b"] },
  ];
  assert.deepEqual(names(usageConfigs(configs, profiles, projects, "personal")), ["h:a", "h:b"], "not a project on another host with the same profile id");
  assert.deepEqual(usageConfigs(configs, profiles, projects, "work"), [], "not another profile's project's");
});

// HA-54: a limit at 80% or more warns, and one that's used up (or a run that was refused) is out.
const now = Date.parse("2026-11-01T10:00:00Z");
const inMin = (m) => new Date(now + m * 60000).toISOString();
const limit = (id, percent, resets_at = inMin(130)) => ({ id, label: id === "session" ? "Session" : "Weekly", percent, resets_at });

test("warns at 80% and says when the limit resets", () => {
  assert.equal(usageAlert({ limits: [limit("session", 79.4)] }, now), null);
  assert.deepEqual(usageAlert({ limits: [limit("session", 40), limit("weekly", 85, inMin(130))] }, now), {
    level: "warn",
    text: "Weekly 85% used · resets in 2h 10m",
    short: "weekly 85% used",
    until: inMin(130),
  });
  assert.equal(usageAlert(undefined, now), null);
  assert.equal(usageAlert({ limits: [] }, now), null);
});

test("a used-up limit or a refused run is out, until it resets", () => {
  assert.equal(usageAlert({ limits: [limit("session", 100, inMin(21))] }, now).text, "Session used up · resets in 21m");
  assert.equal(usageAlert({ limits: [limit("session", 100, inMin(21))] }, now).level, "out");
  // Refused at 60%: a per-model limit, say.
  const refused = usageAlert({ limits: [limit("session", 60)], out_until: inMin(45) }, now);
  assert.deepEqual([refused.level, refused.text], ["out", "Out of usage · resets in 45m"]);
  // Reset since the numbers were read: nothing to warn about.
  assert.equal(usageAlert({ limits: [limit("session", 100, inMin(-1))], out_until: inMin(-1) }, now), null);
  // No reset known: still warns.
  assert.equal(usageAlert({ limits: [limit("session", 90, null)] }, now).text, "Session 90% used");
});

test("reset times read as a countdown, then a day further out", () => {
  assert.equal(resetsIn(inMin(21), now), "21m");
  assert.equal(resetsIn(inMin(180), now), "3h");
  assert.equal(resetsIn(inMin(-5), now), "now");
  assert.equal(resetsPhrase(inMin(65), now), "resets in 1h 5m");
  assert.match(resetsPhrase(inMin(3 * 24 * 60), now), /^resets \w+/);
  assert.equal(resetsPhrase(inMin(-5), now), "has reset");
});
