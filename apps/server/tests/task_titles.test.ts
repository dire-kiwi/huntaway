// Port of server/tests/task_titles.rs: exercise title generation and refresh through the real binary, not the unit-test
// model stub.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { HUNTAWAY, TempDir_new, fixture } from "./common.ts";

function check(dir: string, tasks: string[], mode: string): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env, IA_CLAUDE_BIN: join(dir, "agent"), IA_CODEX_BIN: join(dir, "agent"),
    IA_TITLE_LOG: join(dir, "calls.jsonl"), IA_TITLE_MODE: mode,
  };
  // Don't let the test inherit the running agent's login directory.
  delete env.CODEX_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  return spawnSync("timeout", ["20", HUNTAWAY, "title-check", "--db", join(dir, "board.db"), "--steps", ...tasks], { env, encoding: "utf8" });
}

const count = (s: string, sub: string) => s.split(sub).length - 1;
const has_pair = (args: any[], a: string, b: string) => args.some((x, i) => x === a && args[i + 1] === b);

test("titles_use_the_tasks_runtime_and_login_for_generation_and_refresh", () => {
  const dir = TempDir_new("ia175-titles");
  copyFileSync(fixture("task-titles.py"), join(dir, "agent"));
  chmodSync(join(dir, "agent"), 0o700);
  // Opening title-check without task ids creates a current, isolated schema.
  const first = check(dir, [], "success");
  assert.equal(first.status, 0, first.stderr);
  const c = new DatabaseSync(join(dir, "board.db"));
  try {
    c.exec(`INSERT INTO claude_configs (id,name,config_dir,agent,created_at) VALUES
      ('codex','Codex','~/.codex-title-test','codex','now'),
      ('default-codex','Default Codex','','codex','now'),
      ('claude','Claude','~/.claude-title-test','claude','now');
      INSERT INTO profiles (id,name,claude_config_ids,created_at) VALUES ('p','Test','["codex"]','now');`);
    for (const [id, config] of [["inherited", null], ["default-codex", "default-codex"], ["override", "claude"]]) {
      c.prepare(`INSERT INTO tasks (id,profile_id,title,description,claude_config_id,last_activity_at,created_at,updated_at)
        VALUES (?1,'p','Original title','Fix task naming',?2,'now','now','now')`).run(id, config);
      c.prepare("INSERT INTO messages (task_id,kind,data,created_at) VALUES (?1,'user',?2,'now')")
        .run(id, JSON.stringify({ text: "Also support Codex" }));
    }
  } finally {
    c.close();
  }
  const out = check(dir, ["inherited", "default-codex", "override"], "success");
  assert.equal(out.status, 0, out.stderr);
  const stdout = out.stdout;
  assert.equal(count(stdout, "description: Fix Codex task naming"), 2, stdout);
  assert.equal(count(stdout, "message 1 (Also support Codex): Fix Codex task naming"), 2, stdout);
  assert.ok(stdout.includes("description: Fix the Claude title"), stdout);
  const calls: any[] = readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter((l) => l).map((l) => JSON.parse(l));
  const homes = calls.filter((v) => v.agent === "codex").map((v) => v.home);
  const home = process.env.HOME;
  assert.deepEqual(homes, [`${home}/.codex-title-test`, `${home}/.codex-title-test`, `${home}/.codex`, `${home}/.codex`]);
  const starts = calls.filter((v) => v.request?.method === "thread/start").map((v) => v.request.params);
  assert.equal(starts.length, 4);
  for (const p of starts) {
    assert.equal(p.ephemeral, true);
    assert.equal(p.sandbox, "read-only");
    assert.equal(p.approvalPolicy, "never");
    assert.deepEqual(p.config.mcp_servers, { "user-tools": { enabled: false } });
  }
  assert.ok(starts[0].baseInstructions.includes("write titles"));
  assert.ok(starts[1].baseInstructions.includes("KEEP"));
  const turns: string[] = calls.filter((v) => v.request?.method === "turn/start").map((v) => v.request.params.input[0].text);
  assert.ok(turns[0].includes("<task>\nFix task naming"));
  assert.ok(turns[1].includes("<message>\nAlso support Codex"));
  for (const call of calls.filter((v) => v.agent === "claude")) {
    assert.equal(call.home, `${home}/.claude-title-test`);
    assert.ok(has_pair(call.args, "--model", "haiku"));
    assert.ok(has_pair(call.args, "--output-format", "json"));
  }
  for (const mode of ["empty", "failed"]) {
    const out = check(dir, ["inherited"], mode);
    assert.notEqual(out.status, 0, `${mode} must not produce a title`);
    assert.ok(out.stderr.includes(mode === "empty" ? "no title" : "test failure"), out.stderr);
  }
});
