// Port of the tests in server/src/attachments.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as db from "./db.ts";
import * as testing from "./testing.ts";
import { clean_name, ids_in, mime, of_task, referenced } from "./attachments.ts";

test("ids_are_found_in_messages", () => {
  const a = "0123456789abcdef0123456789abcdef";
  const b = "fedcba9876543210fedcba9876543210";
  const text = `Attached files:\n- /home/me/.local/share/huntaway/attachments/${a}/x.png\n{"text":"C:\\\\data\\\\attachments\\\\${b}\\\\y.txt"}`;
  assert.deepEqual(ids_in(text), [a, b]);
  assert.equal(ids_in("attachments/0123/x attachments attachments/").length, 0);
});

test("messages_the_agent_hasnt_read_yet_are_referred_to", () => {
  const state = testing.state();
  const p = db.insert_profile(state.db(), "p", [], null);
  const task = db.insert_task(state.db(), {
    profile_id: p.id, project_id: null, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: null, effort: null, claude_config_id: null,
  });
  const a = "0123456789abcdef0123456789abcdef";
  const steer = [{ id: "s", text: `Attached files:\n- /data/attachments/${a}/x.png`, from_agent: false, run_id: "r", written: true }];
  db.update_task(state.db(), task.id, [["steering", steer]]);
  assert.ok(of_task(state.db(), task.id).has(a));
  assert.ok(referenced(state.db()).has(a));
});

// HA-138 (ported by HA-209).
test("voice_notes_are_audio", () => {
  assert.equal(mime("voice-note-1.wav"), "audio/wav");
  assert.equal(mime("memo.M4A"), "audio/mp4");
  assert.equal(mime("x.caf"), "audio/x-caf");
});

test("names_are_cleaned", () => {
  assert.equal(clean_name("Screenshot 2026-10-24 at 10.00.png"), "Screenshot_2026-10-24_at_10.00.png");
  assert.equal(clean_name("../../etc/passwd"), "passwd");
  assert.equal(clean_name("..\\x.txt"), "x.txt");
  assert.equal(clean_name(".."), "file");
  assert.equal(clean_name(".env"), "env");
  assert.equal(clean_name("ü.png"), "_.png");
  const long = `${"a".repeat(200)}.png`;
  assert.equal(clean_name(long).length, 100);
  assert.ok(clean_name(long).endsWith(".png"));
});
