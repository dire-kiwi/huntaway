// Port of server/tests/codex_subagents.rs: exercise the actual codex-run process against a deterministic app-server,
// without a model.
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { HUNTAWAY, TempDir_new, fixture } from "./common.ts";

test("a_child_turn_cannot_finish_the_main_turn_or_acknowledge_its_steered_input", async () => {
  const dir = TempDir_new("ia152-adapter");
  const fake = join(dir, "codex");
  copyFileSync(fixture("codex-subagents.py"), fake);
  chmodSync(fake, 0o700);
  const log = join(dir, "requests.jsonl");
  writeFileSync(
    join(dir, "codex.json"),
    JSON.stringify({ cwd: dir, input: true, approval_policy: "untrusted", approvals_reviewer: "user", sandbox: "workspace-write" }),
  );
  writeFileSync(
    join(dir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        huntaway: {
          command: "unused",
          env: {
            IA_URL: "http://127.0.0.1:1",
            IA_TOKEN: "test",
            IA_RUN_ID: "test",
          },
        },
      },
    }),
  );
  // Bounds blocking reads too: a protocol regression must fail rather than hang the test.
  const child = spawn("timeout", ["20", HUNTAWAY, "codex-run", join(dir, "codex.json")], {
    env: { ...process.env, IA_CODEX_BIN: fake, IA_FAKE_CODEX_LOG: log },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exited = new Promise<[number | null, string | null]>((resolve) => child.on("close", (code, signal) => resolve([code, signal])));
  const input = child.stdin!;
  input.write(JSON.stringify({ type: "user", uuid: "initial", message: { content: "Inspect config" } }) + "\n");
  const output = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
  const lines: any[] = [];
  for (;;) {
    const next = await output.next();
    assert.ok(!next.done, "adapter exited before the child completed");
    const value = JSON.parse(next.value);
    const done = value.method === "turn/completed" && value.params?.threadId === "child";
    lines.push(value);
    if (done) break;
  }
  input.end(JSON.stringify({ type: "user", uuid: "steered", message: { content: "Also check env" } }) + "\n");
  for (;;) {
    const next = await output.next();
    if (next.done) break;
    lines.push(JSON.parse(next.value));
  }
  const [code, signal] = await exited;
  const requests: any[] = readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l)
    .map((l) => JSON.parse(l));
  assert.equal(code, 0, `adapter exited with ${code ?? signal}`);
  assert.equal(requests.filter((v) => v.method === "turn/start").length, 1);
  assert.equal(requests.filter((v) => v.method === "turn/steer").length, 1);
  const marker = lines.findIndex((v) => v.method === "warning");
  const replay = lines.findIndex((v) => v.isReplay === true && v.uuid === "steered");
  const main_item = lines.findIndex((v) => v.method === "item/started" && v.params?.threadId === "main");
  assert.ok(marker >= 0 && replay >= 0 && main_item >= 0, JSON.stringify(lines));
  assert.ok(marker < replay && replay < main_item, "only the main agent's activity acknowledges its steering");
  for (const thread of ["child", "review", "compact"]) {
    assert.ok(
      lines.some((v) => isDeepStrictEqual(v, { method: "thread/closed", params: { threadId: thread } })),
      thread,
    );
  }
});
