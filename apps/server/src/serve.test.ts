// Port of server/src/main.rs's tests: what they test is in serve.ts (main.ts runs the command line when it's loaded).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { temp_dir } from "./testing.ts";
import { sleep } from "./util.ts";
import { db_path, loopback_host, older_db_path, parse_serve_args, stamped } from "./serve.ts";

const TOKEN = "serve-test-token";

/**
 * `main.ts serve` with `args`, on 127.0.0.1 with a data dir and home of its own and no agents: `ready` is its port once
 * it says IA_READY, and `stop` kills it.
 */
function start(args: string[]) {
  const home = temp_dir();
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, IA_TOKEN: TOKEN, IA_CLAUDE_BIN: "/bin/false", IA_CODEX_BIN: "/bin/false" };
  delete env.VITEST;
  const argv = [
    "--disable-warning=ExperimentalWarning",
    join(import.meta.dirname, "main.ts"),
    "serve",
    "--host",
    "127.0.0.1",
    "--data-dir",
    join(home, "data"),
    ...args,
  ];
  const child = spawn(process.execPath, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "",
    log = "";
  child.stderr.on("data", (d) => (log += d));
  const ready = new Promise<number>((ok, fail) => {
    child.stdout.on("data", (d) => {
      const m = /^IA_READY (.*)$/m.exec((out += d));
      if (m) ok(JSON.parse(m[1]).port);
    });
    child.once("exit", (code) => fail(new Error(`the server exited (${code}) before it was ready:\n${log}`)));
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
    await once(child, "exit");
  };
  return { ready, stop };
}

/** A port on 127.0.0.1 that nothing listens on (one the system gave out and took back). */
async function free_port(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as any).port as number;
  await new Promise((ok) => s.close(ok));
  return port;
}

// HA-262: the server took connections before it had a handler for them, while it read its commit and seeded the demo,
// so a request that came then (a client reconnecting after a restart) got no answer.
test("a_request_that_comes_while_the_server_starts_is_answered", async () => {
  const port = await free_port();
  const server = start(["--port", String(port), "--demo"]);
  try {
    const deadline = Date.now() + 30_000;
    let res: Response;
    for (;;) {
      try {
        res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(10_000) });
        break;
      } catch (e: any) {
        if (e?.cause?.code !== "ECONNREFUSED" || Date.now() > deadline) throw e;
        await sleep(1);
      }
    }
    assert.equal(res.status, 200);
    assert.equal(await server.ready, port);
  } finally {
    await server.stop();
  }
});

// HA-262: a request's body was read (up to its route's limit, 300 MB for /api/h/…) before its token was checked.
test("a_request_without_the_token_is_refused_before_its_body_is_read", async () => {
  const server = start(["--port", "0"]);
  try {
    const port = await server.ready;
    // A body that doesn't end, to a route that takes 300 MB: refused while it's still coming.
    const status = await new Promise<number>((ok, fail) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/api/h/elsewhere/api/attachments", timeout: 10_000 }, (res) => {
        ok(res.statusCode!);
        req.destroy();
      });
      req.on("timeout", () => fail(new Error("no answer while the body was still coming")));
      req.on("error", fail);
      req.write(Buffer.alloc(3 << 20));
    });
    assert.equal(status, 401);
    // A client that sends its whole body before it reads gets the answer too, and one with the token the route's limit.
    const post = (path: string, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers, body: Buffer.alloc(3 << 20) });
    assert.equal((await post("/api/claude-configs/nope/archive")).status, 401);
    assert.equal((await post("/api/claude-configs/nope/archive", { authorization: `Bearer ${TOKEN}` })).status, 404);
  } finally {
    await server.stop();
  }
});

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
  const write = stamped(
    (...a: any[]) => lines.push(a),
    () => at,
  );
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
