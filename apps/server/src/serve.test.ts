// Port of server/src/main.rs's tests: what they test is in serve.ts (main.ts runs the command line when it's loaded).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { temp_dir } from "./testing.ts";
import { db_path, loopback_host, older_db_path, parse_serve_args, stamped } from "./serve.ts";

test("loopback_host_only_accepts_local_names", () => {
  const host = (h: string) => loopback_host({ host: h });
  assert.ok(host("127.0.0.1:7878") && host("localhost:80") && host("LOCALHOST") && host("[::1]:9"));
  assert.ok(!host("attacker.example:7878") && !host("127.0.0.1.evil.test") && !host("localhost.evil.test:1"));
  assert.ok(!loopback_host({}));
});

test("db_path_keeps_the_database_from_before_the_rename", () => {
  const dir = temp_dir();
  assert.equal(older_db_path(dir), join(dir, "huntaway.db"));
  writeFileSync(join(dir, "issue-agent.db"), "");
  assert.equal(older_db_path(dir), join(dir, "issue-agent.db"));
  writeFileSync(join(dir, "huntaway.db"), "");
  assert.equal(older_db_path(dir), join(dir, "huntaway.db"));
});

test("db_path_is_huntaway_2_db_unless_ia_new_db_file_turns_it_off", () => {
  const dir = temp_dir();
  const was = process.env.IA_NEW_DB_FILE;
  try {
    delete process.env.IA_NEW_DB_FILE;
    assert.equal(db_path(dir), join(dir, "huntaway-2.db"));
    process.env.IA_NEW_DB_FILE = "0";
    assert.equal(db_path(dir), join(dir, "huntaway.db"));
    process.env.IA_NEW_DB_FILE = "1";
    assert.equal(db_path(dir), join(dir, "huntaway-2.db"));
  } finally {
    if (was === undefined) delete process.env.IA_NEW_DB_FILE;
    else process.env.IA_NEW_DB_FILE = was;
  }
});

test("recopy_db_is_a_flag_and_a_variable", () => {
  assert.equal(parse_serve_args([]).recopy_db, false);
  assert.equal(parse_serve_args(["--recopy-db"]).recopy_db, true);
});

test("profile_flags_take_name_dir_pairs", () => {
  const args = parse_serve_args(["--profile", "personal=/claude/personal", "--profile", "a = ~/.a,b=/b=c,"]);
  assert.deepEqual(args.profiles, [["personal", "/claude/personal"], ["a", "~/.a"], ["b", "/b=c"], null]);
  // As from an empty IA_PROFILES.
  assert.deepEqual(parse_serve_args(["--profile", ""]).profiles, [null]);
  for (const bad of ["personal", "=/claude", "personal=", "personal=/a,b"]) {
    assert.throws(() => parse_serve_args(["--profile", bad]), Error, bad);
  }
});

test("serves_console_lines_get_the_time_except_ia_ready_and_stamped_ones", () => {
  // HA-185: "task … starting claude" and "connected to host …" had no time in the server's log.
  const lines: any[][] = [];
  const at = new Date("2026-11-05T00:15:57.481Z");
  const write = stamped((...a: any[]) => lines.push(a), () => at);
  write("connected to host omarchy");
  write("run %s: resuming", "r1");
  write(`IA_READY {"port":1}`);
  write("2026-11-05T00:15:57.000Z", " INFO huntaway:", "listening");
  write({ not: "a string" });
  assert.deepEqual(lines, [
    ["2026-11-05T00:15:57.481Z connected to host omarchy"],
    ["2026-11-05T00:15:57.481Z run %s: resuming", "r1"],
    [`IA_READY {"port":1}`],
    ["2026-11-05T00:15:57.000Z", " INFO huntaway:", "listening"],
    ["2026-11-05T00:15:57.481Z", { not: "a string" }],
  ]);
});
