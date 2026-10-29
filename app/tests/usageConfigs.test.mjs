import assert from "node:assert/strict";
import { test } from "node:test";
import { usageConfigs } from "../src/usageConfigs.ts";

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
