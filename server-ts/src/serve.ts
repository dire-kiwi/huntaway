// Port of `serve` in server/src/main.rs (main.ts has the command line, and loads this only for `serve`).
import * as backup from "./backup.ts";
import * as crash from "./crash.ts";
import * as lag from "./lag.ts";
import { VERSION } from "./hosts/proto.ts";
import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync, closeSync, createReadStream } from "node:fs";
import type { Duplex } from "node:stream";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import * as db from "./db.ts";
import * as api from "./api.ts";
import { readBody, send, errorAnswer, no_route_error, ApiError, type Answer } from "./http.ts";
import { AppState, default_exe, type Identity } from "./state.ts";
import { expand_tilde, new_id, new_token, now, err_str, home_dir } from "./util.ts";
import * as demo from "./demo.ts";
import * as admin from "./update/admin.ts";
import * as release from "./update/release.ts";
import * as staging from "./update/staging.ts";
import * as runner from "./agent/runner.ts";
import * as usage from "./agent/usage.ts";
import * as window from "./agent/window.ts";
import * as focus from "./agent/focus.ts";
import * as runs from "./agent/runs.ts";
import * as task_tmp from "./agent/task_tmp.ts";
import * as pr_watch from "./mcp/pr_watch.ts";
import * as mcp_http from "./mcp/http.ts";
import * as terminal from "./hosts/terminal.ts";
import * as hub from "./hosts/hub.ts";
import * as broker from "./hosts/broker.ts";
import * as broker_proto from "./hosts/broker/proto.ts";
import * as attachments from "./attachments.ts";
import * as automations from "./integrations/automations.ts";
import * as push from "./integrations/push.ts";
import * as merged from "./review/merged.ts";
import * as relocate from "./git/relocate.ts";

const log = {
  info: (...a: any[]) => console.error(new Date().toISOString(), " INFO huntaway:", ...a),
  warn: (...a: any[]) => console.error(new Date().toISOString(), " WARN huntaway:", ...a),
};

const STAMPED = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/;

/**
 * `write` (console.log's or console.error's), with the time in front of what it writes, as the modules' own `log`s and
 * the Rust server's log lines have it: the many plain console lines ("task … starting claude", "connected to host …")
 * had none, which made a server's log hard to read around an update or an outage (HA-185). A line that starts with a
 * time already, and `IA_READY`, which the desktop app and the test scripts read, are left as they are.
 */
export function stamped(write: (...a: any[]) => void, now: () => Date = () => new Date()): (...a: any[]) => void {
  return (...a: any[]) => {
    const first = a[0];
    if (typeof first === "string" && (STAMPED.test(first) || first.startsWith("IA_READY"))) return write(...a);
    // In the first string, which is where console takes a format (`%s`) from.
    if (typeof first === "string") write(`${now().toISOString()} ${first}`, ...a.slice(1));
    else write(now().toISOString(), ...a);
  };
}

/** Put the time in front of every line `huntaway serve` logs with console (see `stamped`). Only for `serve`. */
function stamp_console() {
  console.log = stamped(console.log.bind(console));
  console.info = stamped(console.info.bind(console));
  console.warn = stamped(console.warn.bind(console));
  console.error = stamped(console.error.bind(console));
}

export interface ServeArgs {
  host: string;
  port: number;
  data_dir: string | null;
  ui_dir: string | null;
  source_dir: string | null;
  update_from: string | null;
  release_updates: string | null;
  name: string | null;
  hubs: string[];
  hub_token: string | null;
  broker: string | null;
  broker_token: string | null;
  broker_name: string | null;
  access_token: string | null;
  demo: boolean;
  open_token: boolean;
  profiles: Array<[string, string] | null>;
}

/** A `--profile` value, `NAME=DIR`. A blank one is none, so a deployment can leave `IA_PROFILES=` empty. */
export function parse_profile(s: string): [string, string] | null {
  if (!s.trim()) return null;
  const i = s.indexOf("=");
  const name = i < 0 ? "" : s.slice(0, i).trim();
  const dir = i < 0 ? "" : s.slice(i + 1).trim();
  if (!name || !dir) throw new Error(`${JSON.stringify(s)} isn't NAME=DIR`);
  return [name, dir];
}

const env = (k: string) => process.env[k];
const truthy = (v: string | undefined) => v !== undefined && !["", "0", "false", "no", "off"].includes(v.toLowerCase());

/** `huntaway serve`'s flags, with clap's environment fallbacks. */
export function parse_serve_args(argv: string[]): ServeArgs {
  const a: ServeArgs = {
    host: env("IA_HOST") || "0.0.0.0",
    port: Number(env("IA_PORT") ?? 7878),
    data_dir: env("IA_DATA_DIR") || null,
    ui_dir: env("IA_UI_DIR") || null,
    source_dir: env("IA_SOURCE_DIR") || null,
    update_from: env("IA_UPDATE_FROM") ?? null,
    release_updates: env("IA_RELEASE_UPDATES") ?? null,
    name: env("IA_NAME") ?? null,
    hubs: [],
    hub_token: env("IA_HUB_TOKEN") ?? null,
    broker: env("IA_BROKER") ?? null,
    broker_token: env("IA_BROKER_TOKEN") ?? null,
    broker_name: env("IA_BROKER_NAME") ?? null,
    access_token: env("IA_TOKEN") ?? null,
    demo: truthy(env("IA_DEMO")),
    open_token: truthy(env("IA_OPEN_TOKEN")),
    profiles: [],
  };
  let hubs: string[] | null = null;
  let profiles: Array<[string, string] | null> | null = null;
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let val: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      val = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const next = () => {
      if (val !== undefined) return val;
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case "--host": a.host = next(); break;
      case "--port": a.port = Number(next()); break;
      case "--data-dir": a.data_dir = next(); break;
      case "--ui-dir": a.ui_dir = next(); break;
      case "--source-dir": a.source_dir = next(); break;
      case "--update-from": a.update_from = next(); break;
      case "--release-updates": a.release_updates = next(); break;
      case "--name": a.name = next(); break;
      case "--hub": (hubs ??= []).push(...next().split(",")); break;
      case "--hub-token": a.hub_token = next(); break;
      case "--broker": a.broker = next(); break;
      case "--broker-token": a.broker_token = next(); break;
      case "--broker-name": a.broker_name = next(); break;
      case "--token": a.access_token = next(); break;
      case "--demo": a.demo = true; break;
      case "--open-token": a.open_token = true; break;
      case "--profile": (profiles ??= []).push(...next().split(",").map(parse_profile)); break;
      default: throw new Error(`unexpected argument '${argv[i]}'`);
    }
  }
  a.hubs = hubs ?? (env("IA_HUB") ? env("IA_HUB")!.split(",") : []);
  a.profiles = profiles ?? (env("IA_PROFILES") !== undefined ? env("IA_PROFILES")!.split(",").map(parse_profile) : []);
  return a;
}

/** `<data dir>/huntaway`, or `<data dir>/issue-agent` on a machine that ran the board before it was renamed. */
export function default_data_dir(): string {
  const base = process.env.XDG_DATA_HOME || join(home_dir() ?? ".", ".local/share");
  const dir = join(base, "huntaway"), legacy = join(base, "issue-agent");
  return !existsSync(dir) && isDir(legacy) ? legacy : dir;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The database in a data dir: `huntaway.db`, or `issue-agent.db` from before the rename. */
export function db_path(data_dir: string): string {
  const d = join(data_dir, "huntaway.db"), legacy = join(data_dir, "issue-agent.db");
  let legacyFile = false;
  try {
    legacyFile = statSync(legacy).isFile();
  } catch {}
  return !existsSync(d) && legacyFile ? legacy : d;
}

/** A secret stored in the data dir, created on first use. */
export function load_or_create_token(data_dir: string, file: string): string {
  const path = join(data_dir, file);
  try {
    const t = readFileSync(path, "utf8").trim();
    if (t) return t;
  } catch {}
  const token = new_token();
  // Made private from the start.
  const fd = openSync(path, "w", 0o600);
  writeSync(fd, token);
  closeSync(fd);
  return token;
}

/**
 * `--ui-dir`, else the UI of the package this server runs from (a release's `ui/`, beside its `huntaway`) or the
 * checkout's build. A release this server updated to (`from_app`) serves its own UI even with `--ui-dir`, which it
 * inherits from the server it replaced and which names that server's UI.
 */
function find_ui_dir(explicit: string | null, from_app: boolean, exe: string): string | null {
  const own = join(dirname(exe), "ui");
  if (from_app && existsSync(join(own, "index.html"))) {
    if (explicit) log.info(`serving this release's own UI rather than --ui-dir ${explicit}`);
    return own;
  }
  if (explicit) return explicit;
  const here = dirname(new URL(import.meta.url).pathname);
  return [own, join(here, "../../ui"), join(here, "../../app/dist")].find((p) => existsSync(join(p, "index.html"))) ?? null;
}

/** Whether the request's `Host` names this machine (127.0.0.1, localhost or [::1], with any port). */
export function loopback_host(headers: Record<string, any>): boolean {
  const host: string = headers["host"] ?? "";
  let name: string;
  if (host.startsWith("[")) name = host.slice(1).split("]")[0];
  else {
    const i = host.lastIndexOf(":");
    name = i < 0 ? host : host.slice(0, i);
  }
  return ["127.0.0.1", "localhost", "::1"].includes(name.toLowerCase());
}

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
};

/** Serve a file of the UI build, or index.html (the SPA fallback), as ServeDir with a ServeFile fallback does. */
function serve_ui(ui: string, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    rel = url.pathname;
  }
  let file = normalize(join(ui, rel));
  const root = resolve(ui);
  if (!file.startsWith(root + sep) && file !== root) file = join(ui, "index.html");
  let st = statOr(file);
  if (st?.isDirectory()) {
    file = join(file, "index.html");
    st = statOr(file);
  }
  if (!st?.isFile()) {
    file = join(ui, "index.html");
    st = statOr(file);
  }
  if (!st) {
    res.writeHead(404).end();
    return;
  }
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  const html = type === "text/html";
  // Browsers revalidate index.html on every load; the hashed files under /assets never change, so they're cached for good.
  const policy = url.pathname.startsWith("/assets/") && !html ? "public, max-age=31536000, immutable" : "no-cache";
  res.writeHead(200, { "content-type": type + (type.startsWith("text/") ? "; charset=utf-8" : ""), "content-length": st.size, "cache-control": policy });
  if (req.method === "HEAD") return void res.end();
  createReadStream(file).pipe(res);
}

const statOr = (p: string) => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};

/**
 * `--open-token`'s route: the token for whoever asks, but not through a broker (where whoever asks could be anyone).
 *
 * On a loopback-only server (`--host 127.0.0.1`) it also needs a loopback `Host`, so a page on another site that rebinds
 * its name to 127.0.0.1 can't read the token.
 */
export function open_token(token: string, loopback_only: boolean): (headers: Record<string, any>) => Answer {
  return (headers) => {
    const json = (status: number, v: any): Answer => ({ status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(v)) });
    if (headers[broker.VIA_BROKER] !== undefined || (loopback_only && !loopback_host(headers))) return json(404, no_route_error("GET", "/api/open-token"));
    return json(200, { token });
  };
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "*", "access-control-allow-headers": "*", vary: "origin" };

export async function serve(args: ServeArgs) {
  stamp_console();
  // A bug in a background job is logged rather than ending the server (see crash.ts). What serve itself throws while
  // starting isn't unhandled: main.ts logs it and exits.
  crash.install();
  lag.start();
  // bin/huntaway's variables, which nothing this server starts should see (see update/admin.ts's `exec`).
  admin.take_supervisor();
  admin.reap_inherited();
  let data_dir = args.data_dir ?? default_data_dir();
  mkdirSync(data_dir, { recursive: true });
  data_dir = realpathSync(data_dir);
  // Before opening the database: a newer release this host updated to takes over.
  if (args.release_updates?.trim()) release.exec_installed(data_dir);
  const token = args.access_token?.trim() || load_or_create_token(data_dir, "auth_token");
  const hub_token = load_or_create_token(data_dir, "hub_token");
  const host_id = load_or_create_token(data_dir, "host_id");
  let host_name = args.name?.trim() || "";
  if (!host_name) {
    try {
      host_name = readFileSync("/proc/sys/kernel/hostname", "utf8").trim();
    } catch {
      host_name = (process.env.HOSTNAME ?? "host").trim();
    }
  }
  // Another version (or the Rust server) ran on this data dir last: keep a copy of the database before opening it.
  try {
    backup.on_start(data_dir, db_path(data_dir), VERSION, db.VERSION);
  } catch (e) {
    // Machine-readable, for the Electron shell: its error page says why and offers to start without a backup.
    if (e instanceof backup.BackupFailed) console.log(`IA_BACKUP_FAILED ${JSON.stringify({ reason: e.reason, why: e.why, dir: e.dir })}`);
    throw e;
  }
  // "Start without a backup" was for this start: a restart onto another release makes one again.
  delete process.env[backup.SKIP_ONCE_ENV];
  const conn = db.open(db_path(data_dir));
  backup.record_version(data_dir, VERSION);

  const server = createServer();
  await new Promise<void>((ok, fail) => {
    server.once("error", (e) => fail(new Error(`binding ${args.host}:${args.port}`, { cause: e })));
    server.listen(args.port, args.host, () => ok());
  });
  const port = (server.address() as any).port as number;
  const internal_url = `http://127.0.0.1:${port}`;
  const source_dir = admin.detect_source_dir(args.source_dir);
  const from_app = staging.running_from_app(data_dir, admin.current_exe()) !== null;
  // Without a checkout (e.g. deployed from a CI bundle, or a release), the build or the deployment says which commit it is.
  const running_commit = source_dir ? await admin.head_commit(source_dir) : admin.bundle_commit(from_app);
  const meta: admin.ServerMeta = {
    boot_id: new_id(),
    started_at: now(),
    source_dir,
    running_commit,
    update_from: args.update_from?.trim().replace(/\/+$/, "") || null,
    release: args.release_updates?.trim() ? release.Config_from_env(args.release_updates) : null,
    // What follows the program, `serve` included (as Rust's `args_os().skip(1)`), to exec bin/huntaway with again.
    args: process.argv.slice(2),
  };
  const identity: Identity = { host_id, host_name, token, hub_token, internal_url };
  const state = new AppState(conn, data_dir, identity, meta, default_exe());
  if (args.demo) {
    try {
      await demo.seed(state);
    } catch (e) {
      throw new Error("seeding the demo project", { cause: e });
    }
  }
  // After the demo, which only seeds a host that has no profiles.
  for (const p of args.profiles) {
    if (!p) continue;
    const [name, dir] = p;
    const made = db.ensure_profile(state.db(), name, dir);
    if (made) {
      mkdirSync(state.profile_scratch_dir(made.id), { recursive: true });
      log.info(`made profile ${name} with the Claude config in ${dir}`);
      if (!isDir(expand_tilde(dir))) log.warn(`profile ${name}'s Claude config ${dir} isn't a directory here`);
    }
  }
  api.router(state);
  crash.debug_route(state.local_router!);
  lag.debug_route(state.local_router!);
  const ui = find_ui_dir(args.ui_dir, from_app, admin.current_exe());
  if (ui) log.info(`serving UI from ${ui}`);
  else log.warn("no UI build found; API only (build app/ or pass --ui-dir)");
  const loopback_only = ["127.0.0.1", "::1", "localhost"].includes(args.host) || args.host.startsWith("127.");
  if (args.open_token) log.warn("--open-token: handing the access token to every browser that opens the board");

  const answer = async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0];
    try {
      if (req.method === "OPTIONS" && path.startsWith("/api")) {
        res.writeHead(200, { ...CORS, "access-control-max-age": "86400" }).end();
        return;
      }
      if (path === "/api/open-token" && args.open_token && req.method === "GET") return send(res, open_token(token, loopback_only)(req.headers));
      // Runs' MCP servers, which answer on event streams (see mcp/http.ts).
      if (path.startsWith(mcp_http.PREFIX)) return await mcp_http.serve(state, req, res);
      if (path === "/api" || path.startsWith("/api/")) {
        for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
        const found = state.local_router!.find(path.slice(4));
        const raw = await readBody(req, found?.route.limit ?? 2 << 20);
        const r = api.makeReq(req.method ?? "GET", url, req.headers, raw);
        r.incoming = req;
        send(res, await api.dispatch(state, r));
        return;
      }
      if (ui) return serve_ui(ui, req, res);
      res.writeHead(404).end();
    } catch (e) {
      if (!res.headersSent) {
        // A body over the limit, which isn't read to its end (see readBody): the connection goes after the answer.
        if (e instanceof ApiError && e.status === 413) res.setHeader("connection", "close");
        send(res, errorAnswer(e instanceof ApiError ? e : new ApiError(500, err_str(e))));
      } else res.destroy();
    }
  };
  // What a failed answer throws (an error sending the error, say) ends the connection, rather than the server.
  server.on("request", (req, res) =>
    answer(req, res).catch((e) => {
      console.error(`answering ${req.method} ${(req.url ?? "/").split("?")[0]}:`, e);
      res.destroy();
    }),
  );

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const upgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? "/";
    let path = url.split("?")[0];
    const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
    const reject = (status: number, msg: string) => {
      socket.end(`HTTP/1.1 ${status} ${msg}\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ error: msg })}`);
    };
    if (!path.startsWith("/api/")) return reject(404, "not found");
    let trusted = false;
    // A websocket for this host through the hub's proxy (`/api/h/<this host>/…`): handled by our own routes.
    const via = path.match(/^\/api\/h\/([^/]+)\/(.*)$/);
    if (via && decodeURIComponent(via[1]) === state.host_id) {
      if (!api.authorized(state, req.headers, query)) return reject(401, "unauthorized");
      path = `/api/${via[2]}`;
      trusted = true;
    }
    const found = state.local_router!.find(path.slice(4));
    if (!found?.route.ws) {
      // A linked host's websocket, relayed by the hub.
      if (via && hub.proxy_ws) {
        if (!api.authorized(state, req.headers, query)) return reject(401, "unauthorized");
        return void hub.proxy_ws(state, decodeURIComponent(via[1]), via[2], query, req, socket, head, wss);
      }
      return reject(404, "not found");
    }
    if (found.route.auth && !trusted && !api.authorized(state, req.headers, query)) return reject(401, "unauthorized");
    const r = api.makeReq("GET", `${path}${query ? `?${query.split("&").filter((kv) => !kv.startsWith("token=")).join("&")}` : ""}`, req.headers, Buffer.alloc(0));
    r.params = found.params;
    r.incoming = req;
    if (found.route.pre) {
      try {
        r.pre = await found.route.pre(state, r);
      } catch (e) {
        const a = errorAnswer(e);
        socket.end(`HTTP/1.1 ${a.status} ${STATUS_CODES[a.status] ?? ""}\r\ncontent-type: application/json\r\ncontent-length: ${a.body.length}\r\n\r\n${a.body}`);
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      try {
        found.route.ws!(state, r, ws);
      } catch (e) {
        console.error(`websocket ${path}:`, e);
        ws.close(1011);
      }
    });
  };
  server.on("upgrade", (req, socket, head) =>
    upgrade(req, socket, head).catch((e) => {
      console.error(`websocket ${(req.url ?? "/").split("?")[0]}:`, e);
      socket.destroy();
    }),
  );

  // Agents kept running while we were down; catch up on their output.
  runner.load_active(state);
  runner.auto_compact(state);
  usage.resume_loop(state);
  window.start(state);
  focus.start(state);
  pr_watch.watch_in_review(state);
  terminal.start_reaper(state);
  attachments.start_pruner(state);
  runs.start_pruner(state);
  task_tmp.start_sweeper(state);
  automations.start(state);
  merged.start(state);
  relocate.start_recording(state);
  admin.start_update_check(state);
  release.start(state);
  // Subscribe before outbound links can announce their initial snapshots.
  push.start(state);
  hub.start(state);
  if (args.hubs.length) {
    if (args.hub_token) for (const h of args.hubs) hub.dial_out(state, h, args.hub_token);
    else log.warn("--hub needs --hub-token");
  }
  const broker_url = args.broker?.trim();
  if (broker_url) {
    const name = args.broker_name?.trim() || null;
    const t = args.broker_token?.trim() || null;
    if (t === null) log.warn("--broker needs --broker-token");
    else if (name !== null && !broker_proto.valid_name(name)) log.warn(`bad --broker-name ${JSON.stringify(name)}: use up to 48 lowercase letters, digits and hyphens`);
    else {
      let origin_port: number;
      try {
        origin_port = await broker.origin(server);
      } catch (e) {
        throw new Error("starting the private tunnel origin", { cause: e });
      }
      broker.dial_with_origin(state, broker_url, t, name ?? broker_proto.slug(state.host_name), load_or_create_token(data_dir, "broker_key"), origin_port);
    }
  }
  log.info(`host ${state.host_name} (${state.host_id})`);
  log.info(`data dir: ${data_dir}`);
  const token_from_env = !!args.access_token?.trim();
  log.info(token_from_env ? `listening on http://${args.host}:${port}/ (token from IA_TOKEN)` : `listening on http://${args.host}:${port}/?token=${token}`);
  try {
    staging.settle(state);
  } catch (e) {
    log.warn(`settling the release: ${err_str(e)}`);
  }
  const shutdown = () => {
    log.info("shutting down");
    server.close();
    // Agents' permission prompts are long-polls that would hold a graceful shutdown open.
    setTimeout(() => process.exit(0), 2000).unref();
    server.closeAllConnections?.();
    setImmediate(() => process.exit(0));
  };
  // Before saying it's ready: until then, TERM ends node at once (exiting with 143, which bin/huntaway passes on), and
  // whoever read IA_READY may stop it straight away.
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  admin.watch_supervisor(shutdown);
  // Machine-readable line for the Electron shell.
  console.log(`IA_READY ${JSON.stringify({ port, token: token_from_env ? null : token })}`);
  admin.supervisor_started();
  // The backups this start or an earlier one made are gzipped (see backup.ts), now that the board is up.
  void backup.compress_later(data_dir).catch((e) => log.warn(`compressing the database's backups: ${err_str(e)}`));
}
