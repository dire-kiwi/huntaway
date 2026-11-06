// Port of server/src/agent/assistant/google.rs (HA-125, on the HA-117 branch).
/**
 * Google Workspace for the assistant (API 113): Gmail, Calendar and Drive through a Google Workspace MCP server on the
 * assistant's host, with an OAuth client the user makes, rather than the claude.ai connectors, which come with the Claude
 * login and so would reach every agent on it, project tasks included.
 *
 * The server is [workspace-mcp](https://github.com/taylorwilsdon/google_workspace_mcp) (`uvx workspace-mcp`), a global
 * MCP server of the host named `google` (`SERVER`, the name the approval rules' Google defaults are written for), which
 * the profile switches on. Only the assistant and its routine threads get it: a project's runs skip it whatever their
 * switches say (see agent_tools.add_global). It runs in single-user mode, with Gmail, Calendar and Drive at its
 * `extended` tier, and reads its OAuth client from `client_secret.json` and its refresh token from
 * `credentials/<email>.json`, both in `~/.google_workspace_mcp` in the home of the user the host runs as, readable by
 * that user alone. It's the same in Claude's and Codex's runs: it's a stdio server like any other.
 *
 * The consent step needs a browser, which the host (often headless) hasn't got, and workspace-mcp's own runs only while
 * an agent's turn does, so `huntaway google-auth` (consent.ts) does it: it listens on the host's loopback, which
 * `ssh -L` brings to the user's machine, and writes the credentials file as workspace-mcp reads it.
 *
 * `status` is what the assistant's Google card shows: whether it's connected, as whom, and what's missing if it isn't.
 */
import { readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { delimiter, join } from "node:path";
import * as db from "../../db.ts";
import { ApiError, type Req } from "../../http.ts";
import type { AppState, Shared } from "../../state.ts";
import { err_str, expand_tilde, home_dir as user_home, path_str } from "../../util.ts";
import * as agent_tools from "../agent_tools.ts";
import type { McpServer } from "../agent_tools.ts";
import * as memory from "./memory.ts";
import * as consent from "./google/consent.ts";

/** The MCP server's name, so its tools are `mcp__google__<tool>` (agent/approval_rules.ts's `GOOGLE_SERVER`). */
export const SERVER = "google";
/** The package `uvx` runs, pinned: a new release has to be picked, rather than run with the user's mail the day it's out. */
export const PACKAGE = "workspace-mcp@2.3.0";
/** What it serves: Gmail, Calendar and Drive, at the tier with drafts, labels and Drive's listing. */
export const SERVER_ARGS = ["--single-user", "--tools", "gmail", "calendar", "drive", "--tool-tier", "extended"];
/**
 * Where workspace-mcp looks for its OAuth client (`GOOGLE_CLIENT_SECRET_PATH`) and credentials
 * (`WORKSPACE_MCP_CREDENTIALS_DIR`), and the account it acts as (`USER_GOOGLE_EMAIL`).
 */
export const CLIENT_SECRET_ENV = "GOOGLE_CLIENT_SECRET_PATH";
export const CREDENTIALS_ENV = "WORKSPACE_MCP_CREDENTIALS_DIR";
export const EMAIL_ENV = "USER_GOOGLE_EMAIL";
/** The port `huntaway google-auth` listens on by default (on 127.0.0.1), which `ssh -L` forwards. */
export const CONSENT_PORT = 8765;

/**
 * The scopes workspace-mcp asks for with Gmail, Calendar and Drive (its auth/scopes.py), so the credentials consent.ts
 * writes are enough for every tool it serves and it doesn't ask to sign in again.
 */
export const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
];

/** The scopes the brief can't do without: reading mail, the calendar and Drive (a broader one covers each, as Google's do). */
const NEEDED: Array<[string, string[]]> = [
  ["https://www.googleapis.com/auth/gmail.readonly", ["https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"]],
  ["https://www.googleapis.com/auth/calendar.readonly", ["https://www.googleapis.com/auth/calendar"]],
  ["https://www.googleapis.com/auth/drive.readonly", ["https://www.googleapis.com/auth/drive"]],
];

export function is_google(server: string): boolean {
  return server === SERVER;
}

/** workspace-mcp's own folder, `~/.google_workspace_mcp`, where its defaults are. */
export function home_dir(): string {
  return join(user_home() ?? ".", ".google_workspace_mcp");
}

export function default_client_secret(): string {
  return join(home_dir(), "client_secret.json");
}

export function default_credentials_dir(): string {
  return join(home_dir(), "credentials");
}

/**
 * The server's `mcpServers` entry: `uvx` running workspace-mcp, with absolute paths (an MCP config doesn't expand `~`), and
 * the account to act as when it's known.
 */
export function server_config(email: string | null): any {
  const env: Record<string, string> = {
    [CLIENT_SECRET_ENV]: path_str(default_client_secret()),
    [CREDENTIALS_ENV]: path_str(default_credentials_dir()),
  };
  if (email != null) env[EMAIL_ENV] = email;
  return { type: "stdio", command: "uvx", args: [PACKAGE, ...SERVER_ARGS], env };
}

const SAFE = /^[A-Za-z0-9@._-]$/;

/** A credentials file's name for an account, as workspace-mcp makes it (Python's `quote(email, safe="@._-")`). */
export function credentials_file(email: string): string {
  let name = "";
  for (const b of Buffer.from(email)) {
    const ch = String.fromCharCode(b);
    name += b < 0x80 && SAFE.test(ch) ? ch : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return `${name}.json`;
}

/** The account a credentials file is for, from its name (undoing `credentials_file`), if it's one. */
export function account_of(file: string): string | null {
  if (!file.endsWith(".json")) return null;
  const bytes = Buffer.from(file.slice(0, -5));
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const h = bytes[i] === 0x25 && i + 3 <= bytes.length ? bytes.subarray(i + 1, i + 3).toString("latin1") : null;
    if (h !== null && /^[0-9A-Fa-f]{2}$/.test(h)) {
      out.push(parseInt(h, 16));
      i += 3;
    } else {
      out.push(bytes[i]);
      i += 1;
    }
  }
  let email: string;
  try {
    email = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(out));
  } catch {
    return null;
  }
  return email.includes("@") ? email : null;
}

/** Whether a file can be read by others than its owner. */
function is_private(meta: Stats): boolean {
  return (meta.mode & 0o077) === 0;
}

/** A file the server reads, as the card shows it. */
export interface FileState {
  path: string;
  exists: boolean;
  /** Readable by its owner alone. */
  private: boolean;
}

function stat_of(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function file_state(path: string): FileState {
  const meta = stat_of(path);
  return { path: path_str(path), exists: meta?.isFile() ?? false, private: meta !== null && is_private(meta) };
}

/** An account with credentials in the server's folder. */
export interface Account {
  email: string;
  file: string;
  /** It has a refresh token, so the server can go on using it (without one it lasts an hour). */
  refresh_token: boolean;
  private: boolean;
  scopes: string[];
  /** What the brief needs that it wasn't granted (an unticked box on Google's consent screen). */
  missing_scopes: string[];
}

/** Byte order, as Rust compares strings. */
const cmp = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** The accounts with credentials in `dir`, by email. */
export function accounts(dir: string): Account[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Account[] = [];
  for (const name of names) {
    const email = account_of(name);
    if (email === null) continue;
    const file = join(dir, name);
    const meta = stat_of(file);
    if (!meta?.isFile()) continue;
    let v: any = null;
    try {
      v = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
    const scopes: string[] = Array.isArray(v?.scopes) ? v.scopes.filter((s: any) => typeof s === "string") : [];
    const missing_scopes = NEEDED.filter(([s, broader]) => !scopes.some((g) => g === s || broader.includes(g))).map(([s]) => s);
    out.push({
      email,
      file: path_str(file),
      refresh_token: typeof v?.refresh_token === "string" && v.refresh_token !== "",
      private: is_private(meta),
      scopes,
      missing_scopes,
    });
  }
  return out.sort((a, b) => cmp(a.email, b.email));
}

/** The Google server on this host, as the card shows it. */
export interface ServerState {
  id: string;
  enabled: boolean;
  /** The profile switches it on (its assistant's runs get it). */
  on: boolean;
  command: string;
  /** The command is on this host's PATH (or is a path to a program). */
  command_found: boolean;
}

/** Whether Google is connected for a profile's assistant here, and if not, why not. */
export interface Status {
  connected: boolean;
  /** The account it acts as. */
  account: string | null;
  /** What's in the way, in words, when it isn't connected. */
  problem: string | null;
  /** What's off but doesn't stop it. */
  warnings: string[];
  server: ServerState | null;
  client_secret: FileState;
  credentials_dir: string;
  accounts: Account[];
  /** What to run on this host to sign in (see consent.ts). */
  consent_command: string;
  /** This host's name, for the ssh command. */
  host: string;
  /** The port the consent command listens on. */
  consent_port: number;
}

/** Whether `cmd` can be run: a path to a file, or a name found on PATH. */
export function command_found(cmd: string): boolean {
  const c = cmd.trim();
  if (c === "") return false;
  const runnable = (p: string) => {
    const m = stat_of(p);
    return m !== null && m.isFile() && (m.mode & 0o111) !== 0;
  };
  if (c.includes("/")) return runnable(expand_tilde(c));
  const path = process.env.PATH;
  // (Rust's split_paths: an empty entry is the current folder.)
  return path !== undefined && path.split(delimiter).some((d) => runnable(join(d === "" ? "." : d, c)));
}

/** A config's env value, if it sets it (and it isn't blank). */
function env_of(config: any, key: string): string | null {
  const v = config?.env?.[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Profile `profile_id`'s Google status on this host. */
export function status(s: Shared, profile_id: string): Status {
  const server: McpServer | null = agent_tools.global_mcp_server(s.db(), SERVER);
  const on = server !== null ? (agent_tools.profile_switch(s.db(), profile_id, server.id) ?? false) : false;
  const config = server?.config ?? null;
  const secret = ((v) => (v !== null ? expand_tilde(v) : default_client_secret()))(env_of(config, CLIENT_SECRET_ENV));
  const creds = ((v) => (v !== null ? expand_tilde(v) : default_credentials_dir()))(env_of(config, CREDENTIALS_ENV));
  // The client's id and secret can be given in the env instead of a file.
  const secret_in_env = env_of(config, "GOOGLE_OAUTH_CLIENT_ID") !== null && env_of(config, "GOOGLE_OAUTH_CLIENT_SECRET") !== null;
  const client_secret = file_state(secret);
  const accts = accounts(creds);
  const wanted = env_of(config, EMAIL_ENV);
  let server_state: ServerState | null = null;
  if (server !== null) {
    const command = typeof server.config?.command === "string" ? server.config.command : "";
    server_state = { id: server.id, enabled: server.enabled, on, command, command_found: command_found(command) };
  }
  const warnings: string[] = [];
  const account = wanted !== null ? accts.find((a) => a.email.toLowerCase() === wanted.toLowerCase()) : (accts.find((a) => a.refresh_token) ?? accts[0]);
  const consent_command = `huntaway google-auth --client-secret ${path_str(secret)}`;
  let problem: string | null = null;
  if (server_state === null) problem = "There's no Google server on this host yet: add it here.";
  else if (!server_state.enabled) problem = "The Google server is switched off (Settings → Agent tools).";
  else if (!server_state.on) problem = "The Google server isn't switched on for this profile: switch it on here.";
  else if (!server_state.command_found) {
    problem = `${server_state.command} isn't on this host's PATH: install uv (https://docs.astral.sh/uv/) for the user the host runs as.`;
  } else if (!client_secret.exists && !secret_in_env) {
    problem = `There's no OAuth client at ${client_secret.path}: download your Desktop app client's JSON there.`;
  } else if (account === undefined && wanted !== null) {
    problem = `There are no credentials for ${wanted} in ${path_str(creds)}: sign in with ${consent_command}.`;
  } else if (account === undefined) {
    problem = `Not signed in to Google yet: run ${consent_command} on this host (see An assistant host in docs/guide/assistant.md).`;
  } else if (!account.refresh_token) {
    problem = `${account.email}'s credentials have no refresh token, so they stop working within the hour: sign in again with ${consent_command}.`;
  }
  if (account !== undefined) {
    if (!account.private) warnings.push(`${account.file} can be read by other users on this host: chmod 600 it.`);
    if (account.missing_scopes.length) {
      warnings.push(`${account.email} wasn't given everything the brief reads (${account.missing_scopes.join(", ")}): sign in again and tick every box.`);
    }
  }
  if (client_secret.exists && !client_secret.private) warnings.push(`${client_secret.path} can be read by other users on this host: chmod 600 it.`);
  if (wanted === null && accts.length > 1) {
    warnings.push(`There are credentials for ${accts.length} accounts: set ${EMAIL_ENV} in the server's env to pick one.`);
  }
  return {
    connected: problem === null,
    account: problem === null && account !== undefined ? account.email : null,
    problem,
    warnings,
    server: server_state,
    client_secret,
    credentials_dir: path_str(creds),
    accounts: accts,
    consent_command,
    host: s.host_name,
    consent_port: CONSENT_PORT,
  };
}

/** What a routine's `{{google}}` says (see automations/delivery.ts): `connected as <email>`, or `not connected: <why>`. */
export function status_line(s: Shared, profile_id: string): string {
  let st: Status;
  try {
    st = status(s, profile_id);
  } catch (e) {
    return `not connected: its status couldn't be read (${e instanceof ApiError ? e.message : err_str(e)})`;
  }
  return st.connected ? `connected as ${st.account ?? ""}` : `not connected: ${st.problem ?? ""}`;
}

/**
 * `GET /profiles/{id}/assistant/google[?check=1]` (API 113): the Google card's status. With `check`, the account's refresh
 * token is tried with Google too (`verified`, or `verify_error` saying why it failed).
 */
export async function get(s: AppState, r: Req): Promise<any> {
  const id = r.params.id;
  memory.elsewhere(s, id);
  const st = status(s, id);
  const v: any = { ...st };
  const check = r.query.check;
  if (check !== undefined && check !== "" && check !== "0" && st.connected) {
    const file = st.accounts.find((a) => a.email === st.account)?.file ?? null;
    if (file !== null) {
      try {
        await consent.verify(file, st.client_secret.exists ? st.client_secret.path : null);
        v.verified = true;
      } catch (e) {
        v.verified = false;
        v.verify_error = err_str(e);
      }
    } else v.verified = false;
  }
  return v;
}

/**
 * `POST /profiles/{id}/assistant/google` (API 113): add the Google server to this host (if it hasn't one called `google`)
 * and switch it on for the profile. A server that's there keeps its config. Returns the status.
 */
export async function setup(s: AppState, r: Req): Promise<any> {
  const id = r.params.id;
  memory.elsewhere(s, id);
  const c = s.db();
  if (!db.get_profile(c, id)) throw ApiError.not_found("profile");
  let server = agent_tools.global_mcp_server(c, SERVER);
  if (server === null) {
    // The account to act as, if there's one signed in already.
    const signed_in = accounts(default_credentials_dir()).filter((a) => a.refresh_token);
    const email = signed_in.length === 1 ? signed_in[0].email : null;
    server = agent_tools.add_global_mcp_server(c, SERVER, server_config(email));
  }
  agent_tools.set_profile_switch(c, id, server.id, true);
  return status(s, id);
}
