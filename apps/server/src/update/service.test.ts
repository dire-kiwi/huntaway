import { afterEach, beforeEach, test } from "vite-plus/test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as testing from "../testing.ts";
import * as service from "./service.ts";
import { server_status } from "../api/host.ts";

const KEYS = ["IA_SYSTEMCTL", "IA_LOGINCTL", "XDG_CONFIG_HOME", "IA_SYSTEMD_BOOTED", "IA_DESKTOP_VERSION"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Fake systemctl and loginctl that log their arguments to `<dir>/calls`; systemctl fails with `fail` among them. */
function fakes(fail = "") {
  const dir = testing.temp_dir();
  for (const name of ["systemctl", "loginctl"]) {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> '${dir}/calls'\ncase " $* " in *" ${fail || "-none-"} "*) echo "it failed" >&2; exit 1 ;; esac\n`);
    chmodSync(p, 0o755);
  }
  process.env.IA_SYSTEMCTL = join(dir, "systemctl");
  process.env.IA_LOGINCTL = join(dir, "loginctl");
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  process.env.IA_SYSTEMD_BOOTED = "1";
  const calls = () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n") : []);
  return { dir, calls };
}

const spec = (more: Partial<service.Spec> = {}): service.Spec => ({
  exe: "/opt/huntaway/huntaway",
  args: ["serve", "--host", "127.0.0.1", "--port", "7878"],
  env: [["IA_RELEASE_UPDATES", "dire-kiwi/huntaway"]],
  shell: "/bin/bash",
  cwd: "/home/me",
  port: 7878,
  ...more,
});

test("unit_names_go_by_port", () => {
  assert.equal(service.unit_name(7878), "huntaway.service");
  assert.equal(service.unit_name(7900), "huntaway-7900.service");
});

test("service_of_reads_the_unit_from_the_cgroup", () => {
  assert.deepEqual(service.service_of("0::/user.slice/user-1000.slice/user@1000.service/app.slice/huntaway.service\n"), {
    unit: "huntaway.service",
    user: true,
  });
  assert.deepEqual(service.service_of("0::/system.slice/huntaway.service\n"), { unit: "huntaway.service", user: false });
  // A login session, or an app's scope in the user manager, isn't a service; nor is the user manager itself.
  assert.equal(service.service_of("0::/user.slice/user-1000.slice/session-254.scope\n"), null);
  assert.equal(service.service_of("0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-foot-1.scope\n"), null);
  assert.equal(service.service_of(""), null);
  // cgroup v1.
  assert.deepEqual(service.service_of("12:pids:/x\n1:name=systemd:/user.slice/user-1000.slice/user@1000.service/huntaway-7900.service\n"), {
    unit: "huntaway-7900.service",
    user: true,
  });
});

test("kept_env_keeps_the_servers_settings_not_one_starts", () => {
  const env = {
    IA_RELEASE_UPDATES: "o/r",
    IA_DATA_DIR: "/d",
    IA_RESTART_FILE: "/tmp/x/next",
    IA_BUNDLED_SERVER: "/a",
    IA_DESKTOP_SHELL: "1",
    IA_RECOPY_DB: "1",
    PATH: "/bin",
    HOME: "/h",
  };
  assert.deepEqual(service.kept_env(env), [
    ["IA_DATA_DIR", "/d"],
    ["IA_RELEASE_UPDATES", "o/r"],
  ]);
});

test("unit_text_quotes_for_systemd_and_the_shell", () => {
  const text = service.unit_text(
    spec({ exe: "/home/a b/it's/huntaway", args: ["serve", "--name", 'my "box" 100%', "--data-dir", "/d/$HOME"], env: [["IA_TOKEN", 'a"b%c$d\\e']] }),
  );
  assert.match(text, /^KillMode=process$/m);
  assert.match(text, /^WantedBy=default\.target$/m);
  assert.match(text, /^Restart=on-failure$/m);
  // Environment=: C escapes and %%, but $ is left alone (systemd doesn't expand it there).
  assert.match(text, /^Environment="IA_TOKEN=a\\"b%%c\$d\\\\e"$/m);
  const exec = text.split("\n").find((l) => l.startsWith("ExecStart="))!;
  assert.equal(exec, `ExecStart="/bin/bash" -lc "exec '/home/a b/it'\\\\''s/huntaway' 'serve' '--name' 'my \\"box\\" 100%%' '--data-dir' '/d/$$HOME'"`);
  assert.throws(() => service.unit_text(spec({ args: ["serve", "--name", "a\nb"] })), /can't go in a unit file/);
});

// systemd starts user units in the home folder, so a host started as `huntaway serve --data-dir board` in ~/hosts/a came
// back on ~/board, a new and empty board.
test("the_unit_runs_in_the_folder_the_server_was_started_in", () => {
  const text = service.unit_text(spec({ args: ["serve", "--data-dir", "board"], cwd: "/home/me/hosts/100% a" }));
  assert.match(text, /^WorkingDirectory=-\/home\/me\/hosts\/100%% a$/m);
  const s = testing.state_with({ ...testing.meta(), args: ["serve", "--data-dir", "board"] });
  assert.equal(service.this_server(s, 7878).cwd, process.cwd());
  assert.match(service.unit_text(service.this_server(s, 7878)), new RegExp(`^WorkingDirectory=-${process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
});

test("install_writes_and_enables_the_unit_and_turns_lingering_on", async () => {
  const { dir, calls } = fakes();
  const said: string[] = [];
  const st = await service.install(spec(), (l) => said.push(l));
  const path = join(dir, "config/systemd/user/huntaway.service");
  assert.equal(st.path, path);
  assert.equal(st.installed, true);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.match(readFileSync(path, "utf8"), /exec '\/opt\/huntaway\/huntaway' 'serve' '--host' '127\.0\.0\.1' '--port' '7878'/);
  const c = calls();
  assert.ok(c.includes("systemctl --user daemon-reload"), c.join("\n"));
  assert.ok(c.includes("systemctl --user enable huntaway.service"), c.join("\n"));
  // Not started: that's for whoever asked (the hand-over, or install-service).
  assert.ok(!c.some((l) => / start /.test(` ${l} `)), c.join("\n"));
  if (!existsSync(join("/var/lib/systemd/linger", st.user))) assert.ok(c.includes("loginctl enable-linger"), c.join("\n"));
  assert.ok(said.some((l) => l.startsWith("wrote ")));
});

test("install_says_when_lingering_cant_be_turned_on_and_carries_on", async (t) => {
  const { calls } = fakes();
  const st0 = service.status(7878)!;
  if (existsSync(join("/var/lib/systemd/linger", st0.user))) return t.skip("lingering is on here already");
  // loginctl fails on its own argument.
  const dir2 = testing.temp_dir();
  writeFileSync(join(dir2, "loginctl"), "#!/bin/sh\necho 'Access denied' >&2\nexit 1\n");
  chmodSync(join(dir2, "loginctl"), 0o755);
  process.env.IA_LOGINCTL = join(dir2, "loginctl");
  const said: string[] = [];
  await service.install(spec(), (l) => said.push(l));
  assert.ok(
    said.some((l) => l.includes("Access denied") && l.includes("sudo loginctl enable-linger")),
    said.join("\n"),
  );
  assert.ok(calls().includes("systemctl --user enable huntaway.service"));
});

test("install_fails_with_systemctls_error", async () => {
  fakes("enable");
  await assert.rejects(
    service.install(spec(), () => {}),
    /systemctl --user enable huntaway\.service failed: it failed/,
  );
});

test("status_is_none_without_systemd_or_from_the_desktop_app", () => {
  fakes();
  process.env.IA_SYSTEMD_BOOTED = "0";
  assert.equal(service.status(7878), null);
  process.env.IA_SYSTEMD_BOOTED = "1";
  assert.ok(service.status(7878));
  process.env.IA_DESKTOP_VERSION = "0.5.0";
  assert.equal(service.status(7878), null);
});

test("status_says_whether_the_unit_is_installed_and_enabled", async () => {
  const { dir } = fakes();
  let st = service.status(7900)!;
  assert.equal(st.unit, "huntaway-7900.service");
  assert.equal(st.installed, false);
  assert.equal(st.enabled, false);
  // A test isn't run as a service of that name.
  assert.equal(st.running, false);
  await service.install(spec({ port: 7900 }), () => {});
  // The fake systemctl doesn't link it into default.target.wants, as `enable` does.
  const wants = join(dir, "config/systemd/user/default.target.wants");
  mkdirSync(wants, { recursive: true });
  symlinkSync(join(dir, "config/systemd/user/huntaway-7900.service"), join(wants, "huntaway-7900.service"));
  st = service.status(7900)!;
  assert.equal(st.installed, true);
  assert.equal(st.enabled, true);
});

test("install_and_switch_needs_bin_huntaway", () => {
  fakes();
  const s = testing.state();
  assert.throws(() => service.install_and_switch(s, 7878), /wasn't started by bin\/huntaway/);
  assert.equal(s.restart, null);
});

// A server started on `--port 0` (as test servers are) got a unit that took another free port, not the one it's named for.
test("this_server_runs_on_the_port_it_has", () => {
  const s = testing.state_with({ ...testing.meta(), args: ["serve", "--host", "127.0.0.1", "--port", "0", "--recopy-db"] });
  const sp = service.this_server(s, 7900);
  assert.deepEqual(sp.args, ["serve", "--host", "127.0.0.1", "--port", "0", "--port", "7900"]);
  assert.equal(sp.port, 7900);
});

// A server started as bare `huntaway` (no arguments, run as serve) got a unit running `huntaway --port N`, which exits
// with "unrecognized subcommand", so Install service took the host down.
test("this_server_names_serve_for_a_server_started_without_arguments", () => {
  const sp = service.this_server(testing.state_with({ ...testing.meta(), args: [] }), 7878);
  assert.deepEqual(sp.args, ["serve", "--port", "7878"]);
});

// GET /admin/server failed (500) on a state without a listener's URL, once systemd was there.
test("server_status_has_the_service_for_its_port", async () => {
  fakes();
  assert.equal((await server_status(testing.state())).service, undefined);
  const s = testing.state_as({ host_id: "h", host_name: "desktop", token: "", hub_token: "", internal_url: "http://127.0.0.1:7900" });
  assert.equal((await server_status(s)).service.unit, "huntaway-7900.service");
  process.env.IA_SYSTEMD_BOOTED = "0";
  assert.equal((await server_status(s)).service, undefined);
});

// systemd's own parser, where it's installed: it warns about a value it ignores (a quoted WorkingDirectory=, which it
// doesn't unquote, isn't absolute), starting with the file's path, and says nothing about a unit it reads as written.
test("systemd_reads_the_unit_without_complaint", (t) => {
  const dir = testing.temp_dir();
  const cwd = join(dir, "100% a b");
  mkdirSync(cwd);
  const file = join(dir, "huntaway-7999.service");
  writeFileSync(
    file,
    service.unit_text(spec({ exe: "/bin/true", shell: "/bin/sh", cwd, port: 7999, env: [["IA_X", 'a"b%c$d\\e']], args: ["serve", "--name", "it's 100%"] })),
  );
  const r = spawnSync("systemd-analyze", ["verify", file], { encoding: "utf8" });
  if (r.error) return t.skip("no systemd-analyze here");
  // Only what it says about this unit: it reads the units this one depends on by default too, and warns about theirs
  // (GitHub's runners have system units with options systemd has dropped).
  const mine = `${r.stdout}${r.stderr}`.split("\n").filter((l) => l.includes(file) || l.includes("huntaway-7999.service"));
  assert.deepEqual(mine, []);
});
