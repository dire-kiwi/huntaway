import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import * as testing from "../testing.ts";
import { ssh_host, ssh_host_cli } from "./ssh.ts";

/** A port nothing listens on (one the system just handed out and took back). */
async function free_port(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

/** A host on `port` that answers `/api/health` and `/api/info`, as ssh-host asks them. */
async function fake_host(port: number): Promise<Server> {
  const s = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/api/info" ? JSON.stringify({ host_id: "h1" }) : "{}");
  });
  await new Promise<void>((r) => s.listen(port, "127.0.0.1", r));
  return s;
}

/** What `f` prints with console.log. */
async function printed(f: () => Promise<void>): Promise<string> {
  const log = console.log;
  let out = "";
  console.log = (s: string) => (out += s);
  try {
    await f();
  } finally {
    console.log = log;
  }
  return out;
}

// HA-271: a hub that reconnected while an Update restarted the host started a second one, which took the port from the
// release being started (and marked it bad). Since HA-278 it never starts one, but still waits for one that's restarting.
test("ssh_host_waits_for_a_host_that_comes_back", async () => {
  const data_dir = testing.temp_dir();
  writeFileSync(join(data_dir, "auth_token"), "tok\n");
  const port = await free_port();
  let host: Server | null = null;
  const later = setTimeout(async () => (host = await fake_host(port)), 1000);
  try {
    const out = JSON.parse(await printed(() => ssh_host(port, data_dir, { wait_ms: 10_000 })));
    assert.equal(out.started, false);
    assert.equal(out.token, "tok");
    assert.equal(out.info.host_id, "h1");
  } finally {
    clearTimeout(later);
    (host as Server | null)?.close();
  }
});

// HA-278: ssh-host doesn't start a host (the machine keeps one running, as a user service on Linux), nor fail on the
// flags that older authorized_keys lines give it.
test("ssh_host_does_not_start_a_host", async () => {
  const data_dir = testing.temp_dir();
  const port = await free_port();
  await assert.rejects(ssh_host(port, data_dir, { wait_ms: 500 }), /no host is running on port/);
  // As the hub runs it when a host is being added, which doesn't wait.
  process.env.SSH_ORIGINAL_COMMAND = "link";
  try {
    await assert.rejects(ssh_host_cli(["--port", String(port), "--data-dir", data_dir, "--name", "x", "--no-start"]), /no host is running on port/);
  } finally {
    delete process.env.SSH_ORIGINAL_COMMAND;
  }
  assert.equal(existsSync(join(data_dir, "serve.log")), false);
});
