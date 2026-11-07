// Running a host as a user systemd service (Linux; HA-278). A host's page offers to install one (`POST /admin/service`),
// and `huntaway install-service [serve flags…]` installs one on the machine itself, for a host that isn't running yet
// (an SSH host, which a hub no longer starts: see hosts/ssh.ts).
//
// The unit runs `huntaway serve` with the same flags and IA_* environment, through the user's login shell (so agents get
// the usual PATH), with `KillMode=process`, so stopping or restarting the service leaves agents (under ia-shim) and
// terminals running. Lingering is turned on (`loginctl enable-linger`), so the service starts at boot rather than when
// the user logs in.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { run_cmd } from "../proc.ts";
import type { AppState } from "../state.ts";
import { err_str, home_dir, new_id, sleep } from "../util.ts";
import * as admin from "./admin.ts";

/** Programs and folders, which tests replace: `IA_SYSTEMCTL`, `IA_LOGINCTL`, and `XDG_CONFIG_HOME` for the unit's folder. */
const systemctl = () => process.env.IA_SYSTEMCTL || "systemctl";
const loginctl = () => process.env.IA_LOGINCTL || "loginctl";

/** The unit for a host on `port`: `huntaway.service` on the default port, else `huntaway-<port>.service`. */
export function unit_name(port: number): string {
  return port === 7878 ? "huntaway.service" : `huntaway-${port}.service`;
}

/** Where user units go: `$XDG_CONFIG_HOME/systemd/user`, else `~/.config/systemd/user`. */
export function unit_dir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(home_dir() ?? ".", ".config"), "systemd/user");
}

/**
 * Whether this machine can run user services: Linux booted with systemd (sd_booted's check), and not the desktop app's
 * server, which the app starts and stops itself. `IA_SYSTEMD_BOOTED` (`1` or `0`) overrides the check, for tests.
 */
export function available(): boolean {
  if (process.env.IA_DESKTOP_VERSION) return false;
  const forced = process.env.IA_SYSTEMD_BOOTED;
  if (forced !== undefined) return forced === "1";
  return process.platform === "linux" && existsSync("/run/systemd/system");
}

/** The systemd service a process is in, from its `/proc/<pid>/cgroup`: the unit, and whether it's a user one. */
export function service_of(cgroup: string): { unit: string; user: boolean } | null {
  // cgroup v2's line is `0::/path`; v1 has a `name=systemd` hierarchy.
  const line = cgroup.split("\n").find((l) => l.startsWith("0::")) ?? cgroup.split("\n").find((l) => l.includes(":name=systemd:"));
  if (!line) return null;
  const path = line.slice(line.indexOf(":", line.indexOf(":") + 1) + 1);
  const last = path.split("/").pop() ?? "";
  if (!last.endsWith(".service")) return null;
  return { unit: last, user: /\/user@\d+\.service\//.test(path) };
}

function own_service(): { unit: string; user: boolean } | null {
  try {
    return service_of(readFileSync("/proc/self/cgroup", "utf8"));
  } catch {
    return null;
  }
}

/** `GET /admin/server`'s `service`, where `available`. */
export interface Status {
  unit: string;
  /** The unit file. */
  path: string;
  installed: boolean;
  /** Started at boot (or login, without lingering). */
  enabled: boolean;
  /** This server runs as that service. */
  running: boolean;
  /** Another systemd service this server runs as (`<unit>`, or `<unit> (system)`), which looks after it already. */
  other: string | null;
  /** Lingering is on for the user, so the user's services start at boot. */
  linger: boolean;
  user: string;
}

const user_name = () => {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? "";
  }
};

export function status(port: number): Status | null {
  if (!available()) return null;
  const unit = unit_name(port);
  const path = join(unit_dir(), unit);
  const user = user_name();
  const own = own_service();
  const running = own !== null && own.user && own.unit === unit;
  const other = own === null || running ? null : own.user ? own.unit : `${own.unit} (system)`;
  return {
    unit,
    path,
    installed: existsSync(path),
    enabled: existsSync(join(unit_dir(), "default.target.wants", unit)),
    running,
    other,
    linger: existsSync(join("/var/lib/systemd/linger", user)),
    user,
  };
}

// ---------- the unit ----------

/** What the unit runs: `exe` with `args` (`serve …`), and `env` on top of the user manager's environment. */
export interface Spec {
  exe: string;
  args: string[];
  env: Array<[string, string]>;
  /** The login shell it runs through. */
  shell: string;
  port: number;
}

/**
 * The IA_* variables a server's unit keeps: those that configure it (`IA_RELEASE_UPDATES`, `IA_DATA_DIR`, `IA_CLAUDE_BIN`
 * and the rest), not those that `bin/huntaway`, the desktop app or a restart give a single start.
 */
export function kept_env(env: NodeJS.ProcessEnv): Array<[string, string]> {
  const ONCE = [
    "IA_TS_EXE",
    "IA_RESTART_FILE",
    "IA_SUPERVISOR_PID",
    "IA_SERVE_SIGNALS",
    "IA_MALLOC_MMAP",
    "IA_BUNDLED_SERVER",
    "IA_SKIP_DB_BACKUP_ONCE",
    "IA_RECOPY_DB",
  ];
  return Object.entries(env)
    .filter((e): e is [string, string] => e[0].startsWith("IA_") && !ONCE.includes(e[0]) && !e[0].startsWith("IA_DESKTOP_") && e[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The spec that runs this server again: its command (the release it was installed as, not one it updated to), flags and environment. */
export function this_server(state: AppState, port: number): Spec {
  // A server that started a release it updated to (in `<data dir>/app/`) has the one it was installed as in
  // IA_BUNDLED_SERVER (see release.ts's exec_installed), which starts the newest release again at startup.
  const exe = process.env.IA_BUNDLED_SERVER || admin.current_exe();
  // On the port it has, which the unit is named for, rather than another free one for `--port 0`.
  return { exe, args: [...admin.restart_args(state.meta.args), "--port", String(port)], env: kept_env(process.env), shell: login_shell(), port };
}

export const login_shell = () => process.env.SHELL || "/bin/sh";

/** A word for `sh`, single-quoted. */
const sh_quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** A double-quoted word for a unit file: C escapes for `\` and `"`, with `%` (specifiers) doubled, and `$` too where `dollar`. */
function unit_quote(s: string, dollar: boolean): string {
  let q = s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  if (dollar) q = q.replaceAll("$", "$$$$");
  return `"${q}"`;
}

export function unit_text(spec: Spec): string {
  for (const s of [spec.exe, spec.shell, ...spec.args, ...spec.env.flat()]) {
    if (/[\n\r\0]/.test(s)) throw new Error(`${JSON.stringify(s)} can't go in a unit file`);
  }
  const command = `exec ${[spec.exe, ...spec.args].map(sh_quote).join(" ")}`;
  return [
    "# Written by Huntaway (a host's page in Settings → Hosts, or `huntaway install-service`).",
    "[Unit]",
    `Description=Huntaway host on port ${spec.port}`,
    "",
    "[Service]",
    ...spec.env.map(([k, v]) => `Environment=${unit_quote(`${k}=${v}`, false)}`),
    // Through the login shell, so agents get the PATH they'd get from a terminal.
    `ExecStart=${unit_quote(spec.shell, true)} -lc ${unit_quote(command, true)}`,
    "Restart=on-failure",
    "RestartSec=5",
    // Agents run under ia-shim, and terminals in tmux: a stop or restart of the service leaves them running.
    "KillMode=process",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

// ---------- installing ----------

/** The environment for systemctl: the user manager's runtime folder, which a server started outside a login session may lack. */
function ctl_env(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.XDG_RUNTIME_DIR && typeof process.getuid === "function") env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  return env;
}

async function ctl(program: string, args: string[]): Promise<{ success: boolean; out: string }> {
  try {
    const o = await run_cmd(program, args, { env: ctl_env() });
    return { success: o.success, out: (o.stderr.trim() || o.stdout.trim()).slice(0, 2000) };
  } catch (e) {
    return { success: false, out: err_str(e) };
  }
}

async function systemctl_user(args: string[]): Promise<void> {
  const o = await ctl(systemctl(), ["--user", ...args]);
  if (!o.success) throw new Error(`systemctl --user ${args.join(" ")} failed${o.out ? `: ${o.out}` : ""}`);
}

/**
 * Write the unit for `spec`, turn lingering on and enable the unit; `say` gets what's done. It doesn't start it. A
 * failure to turn lingering on is only said: the service then starts when the user logs in.
 */
export async function install(spec: Spec, say: (line: string) => void): Promise<Status> {
  if (!available()) throw new Error("this machine doesn't run systemd, so it can't run the host as a user service");
  const unit = unit_name(spec.port);
  const path = join(unit_dir(), unit);
  const text = unit_text(spec);
  mkdirSync(dirname(path), { recursive: true });
  // 0600: its environment may hold tokens (IA_TOKEN, IA_HUB_TOKEN).
  const tmp = `${path}.${new_id()}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  say(`wrote ${path}`);
  const user = user_name();
  if (!existsSync(join("/var/lib/systemd/linger", user))) {
    const o = await ctl(loginctl(), ["enable-linger"]);
    if (o.success) say(`turned lingering on for ${user}, so the service starts at boot`);
    else say(`couldn't turn lingering on (${o.out}), so the service starts when ${user} logs in; \`sudo loginctl enable-linger ${user}\` starts it at boot`);
  }
  // Lingering starts the user manager, if it wasn't running: give it a few seconds.
  for (let i = 0; ; i++) {
    try {
      await systemctl_user(["daemon-reload"]);
      break;
    } catch (e) {
      if (i >= 20) throw e;
      await sleep(250);
    }
  }
  await systemctl_user(["enable", unit]);
  say(`enabled ${unit}`);
  return status(spec.port)!;
}

/**
 * Install this server's unit and hand over to it, as a restart job: once this server (and `bin/huntaway`, whose process
 * it is) has stopped, a detached shell starts the service, which starts the server again with the same flags. Agents keep
 * running, as over any restart.
 */
export function install_and_switch(state: AppState, port: number) {
  if (!available()) throw new Error("this machine doesn't run systemd, so it can't run the host as a user service");
  // As a restart does, this goes by bin/huntaway's process, which is the server's.
  if (admin.supervisor_pid() === null) throw new Error("this server wasn't started by bin/huntaway, so it can't hand over to a service");
  const spec = this_server(state, port);
  admin.begin(state, async (s) => {
    const st = await install(spec, (l) => admin.log_line(s, l));
    admin.set_phase(s, "restarting", null);
    // Give the websocket a moment to deliver the final events.
    await sleep(300);
    // Already that service: restart it, so it picks up the unit as written now.
    hand_over(st.unit, st.running ? "restart" : "start");
  });
}

/** Stop this server and have systemd start (or restart) `unit` once it's gone. */
function hand_over(unit: string, how: "start" | "restart") {
  const pid = admin.supervisor_pid();
  if (pid === null) throw new Error("this server wasn't started by bin/huntaway, so it can't hand over to a service");
  if (how === "restart") {
    // systemd stops this server itself; with KillMode=process only its main process, as a stop would.
    spawn(systemctl(), ["--user", "restart", unit], { detached: true, stdio: "ignore", env: ctl_env() }).unref();
    return;
  }
  // Wait up to 30 s for the server to go (and free its port), then start the service.
  const script = `i=0; while kill -0 "$1" 2>/dev/null && [ $i -lt 150 ]; do sleep 0.2; i=$((i+1)); done; exec "$2" --user start "$3"`;
  spawn("sh", ["-c", script, "sh", String(pid), systemctl(), unit], { detached: true, stdio: "ignore", env: ctl_env() }).unref();
  process.kill(pid, "SIGTERM");
}

// ---------- `huntaway install-service` ----------

/**
 * `huntaway install-service [serve flags…]`: install a user service that runs `huntaway serve` with those flags (and this
 * environment's IA_* variables), and start it, or restart it if it's running already. A host that's running on the port
 * some other way is left alone: stop it, then start the service.
 */
export async function install_cli(argv: string[]): Promise<void> {
  const { parse_serve_args } = await import("../serve.ts");
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: huntaway install-service [serve flags…]\n\nRuns `huntaway serve [serve flags…]` as a user systemd service, started at boot.");
    return;
  }
  const port = parse_serve_args(argv).port;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("install-service needs the port the host is to listen on (--port N)");
  const spec: Spec = { exe: admin.current_exe(), args: ["serve", ...argv], env: kept_env(process.env), shell: login_shell(), port };
  const st = await install(spec, (l) => console.log(l));
  const active = (await ctl(systemctl(), ["--user", "is-active", st.unit])).success;
  if (active) {
    await systemctl_user(["restart", st.unit]);
    console.log(`restarted ${st.unit}`);
  } else if (await listening(port)) {
    console.log(`A host is running on port ${port} already, so ${st.unit} isn't started: stop that one, then run \`systemctl --user start ${st.unit}\`.`);
    return;
  } else {
    await systemctl_user(["start", st.unit]);
    console.log(`started ${st.unit}`);
  }
  console.log(`Its log: journalctl --user -u ${st.unit}`);
}

async function listening(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}
