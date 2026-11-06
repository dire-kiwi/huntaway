// Port of server/src/agent/assistant/google/tests.rs (HA-125, on the HA-117 branch).
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute, join, dirname } from "node:path";
import * as db from "../../../db.ts";
import type { AppState } from "../../../state.ts";
import * as testing from "../../../testing.ts";
import { err_str, path_str } from "../../../util.ts";
import { dispatch, makeReq, router } from "../../../api.ts";
import * as agent_tools from "../../agent_tools.ts";
import { mcp_server_config } from "../../codex/adapter.ts";
import { get_or_create } from "../../assistant.ts";
import * as consent from "./consent.ts";
import {
  CLIENT_SECRET_ENV,
  CREDENTIALS_ENV,
  EMAIL_ENV,
  PACKAGE,
  SCOPES,
  SERVER,
  account_of,
  credentials_file,
  server_config,
  status,
  status_line,
} from "../google.ts";

const state = testing.state;

async function call(s: AppState, method: string, path: string, body?: any): Promise<[number, any]> {
  if (!s.local_router) router(s);
  const headers: Record<string, string> = { authorization: "Bearer " };
  if (body !== undefined) headers["content-type"] = "application/json";
  const a = await dispatch(s, makeReq(method, path, headers, body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))));
  const text = a.body.toString("utf8");
  try {
    return [a.status, JSON.parse(text)];
  } catch {
    return [a.status, text];
  }
}

const mode = (p: string) => statSync(p).mode & 0o777;

/** A Google server whose files are in `dir` (not the home folder), run by a program that's there. */
function test_config(dir: string, email: string | null): any {
  const bin = join(dir, "uvx");
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);
  const c = server_config(email);
  c.command = path_str(bin);
  c.env[CLIENT_SECRET_ENV] = path_str(join(dir, "client_secret.json"));
  c.env[CREDENTIALS_ENV] = path_str(join(dir, "credentials"));
  return c;
}

const CLIENT = '{"installed": {"client_id": "id.apps.googleusercontent.com", "client_secret": "shh", "redirect_uris": ["http://localhost"]}}';

function creds(refresh: string | null, scopes: string[]): string {
  return JSON.stringify({ token: "at", refresh_token: refresh, token_uri: "https://oauth2.googleapis.com/token", client_id: "id", client_secret: "shh", scopes, expiry: null });
}

const set_config = (s: AppState, id: string, c: any) => db.run(s.db(), "UPDATE agent_mcp_servers SET config=?1 WHERE id=?2", JSON.stringify(c), id);

test("credentials_files_are_named_as_workspace_mcp_names_them", () => {
  assert.equal(credentials_file("sam@example.com"), "sam@example.com.json");
  assert.equal(credentials_file("sam+news@example.com"), "sam%2Bnews@example.com.json");
  assert.equal(account_of("sam%2Bnews@example.com.json"), "sam+news@example.com");
  assert.equal(account_of("sam@example.com.json"), "sam@example.com");
  // Its other files aren't accounts.
  assert.equal(account_of("oauth_states.json"), null);
  assert.equal(account_of("notes.txt"), null);
  assert.equal(account_of("a%2@b.json"), "a%2@b");
});

test("the_server_runs_workspace_mcp_pinned_with_gmail_calendar_and_drive", () => {
  const c = server_config("sam@example.com");
  assert.equal(c.type, "stdio");
  assert.equal(c.command, "uvx");
  assert.deepEqual(c.args, ["workspace-mcp@2.3.0", "--single-user", "--tools", "gmail", "calendar", "drive", "--tool-tier", "extended"]);
  assert.equal(c.env[EMAIL_ENV], "sam@example.com");
  // Absolute paths, as an MCP config doesn't expand ~.
  for (const k of [CLIENT_SECRET_ENV, CREDENTIALS_ENV]) assert.ok(isAbsolute(c.env[k]), k);
  assert.ok(!(EMAIL_ENV in server_config(null).env));
});

test("the_card_says_what_is_missing_until_google_is_connected", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  const url = `/api/profiles/${p.id}/assistant/google`;
  const problem = (v: any) => (typeof v.problem === "string" ? v.problem : "");
  // No server yet.
  let [st, v] = await call(s, "GET", url);
  assert.equal(st, 200, JSON.stringify(v));
  assert.deepEqual([v.connected, v.server], [false, null]);
  assert.ok(problem(v).includes("no Google server"), JSON.stringify(v));
  assert.ok(status_line(s, p.id).startsWith("not connected: There's no Google server"), status_line(s, p.id));
  // Adding it makes the server and switches it on for the profile.
  [st, v] = await call(s, "POST", url);
  assert.equal(st, 200, JSON.stringify(v));
  const server = agent_tools.global_mcp_server(s.db(), SERVER)!;
  assert.equal(server.config.args[0], PACKAGE);
  assert.equal(agent_tools.profile_switch(s.db(), p.id, server.id), true);
  assert.equal(v.server.on, true);
  // Once more keeps it as it is (here, pointed at a folder of the test's own).
  const dir = testing.temp_dir();
  set_config(s, server.id, test_config(dir, null));
  [, v] = await call(s, "POST", url);
  assert.deepEqual(agent_tools.global_mcp_server(s.db(), SERVER)!.config, test_config(dir, null));
  assert.ok(problem(v).includes("no OAuth client"), JSON.stringify(v));
  // Switched off for the profile.
  agent_tools.set_profile_switch(s.db(), p.id, server.id, false);
  assert.ok(status(s, p.id).problem!.includes("isn't switched on for this profile"));
  agent_tools.set_profile_switch(s.db(), p.id, server.id, true);
  // The client's there; no one's signed in.
  writeFileSync(join(dir, "client_secret.json"), CLIENT);
  chmodSync(join(dir, "client_secret.json"), 0o600);
  let stt = status(s, p.id);
  assert.ok(stt.problem!.includes("Not signed in to Google yet: run huntaway google-auth --client-secret"), JSON.stringify(stt));
  assert.ok(stt.consent_command.includes(path_str(join(dir, "client_secret.json"))));
  // Signed in without a refresh token.
  const cdir = join(dir, "credentials");
  mkdirSync(cdir);
  const file = join(cdir, "sam@example.com.json");
  writeFileSync(file, creds(null, SCOPES));
  chmodSync(file, 0o600);
  assert.ok(status(s, p.id).problem!.includes("no refresh token"));
  // With one: connected, but its file is readable by others, and it was given less than the brief reads.
  writeFileSync(file, creds("rt", ["openid", "https://www.googleapis.com/auth/calendar"]));
  chmodSync(file, 0o644);
  [, v] = await call(s, "GET", url);
  assert.deepEqual([v.connected, v.account], [true, "sam@example.com"], JSON.stringify(v));
  const warnings = JSON.stringify(v.warnings);
  assert.ok(warnings.includes("chmod 600") && warnings.includes("gmail.readonly") && warnings.includes("drive.readonly") && !warnings.includes("calendar.readonly"), warnings);
  assert.equal(status_line(s, p.id), "connected as sam@example.com");
  chmodSync(file, 0o600);
  writeFileSync(file, creds("rt", SCOPES));
  assert.deepEqual(status(s, p.id).warnings, []);
  // A second account: the server has to be told which.
  const other = join(cdir, "kim@example.com.json");
  writeFileSync(other, creds("rt", SCOPES));
  chmodSync(other, 0o600);
  assert.ok(status(s, p.id).warnings[0].includes(EMAIL_ENV));
  // Told one it has no credentials for.
  set_config(s, server.id, test_config(dir, "lee@example.com"));
  assert.ok(status(s, p.id).problem!.includes("no credentials for lee@example.com"));
  set_config(s, server.id, test_config(dir, "kim@example.com"));
  assert.equal(status(s, p.id).account, "kim@example.com");
  // A program that isn't there.
  const c = test_config(dir, null);
  c.command = "no-such-uvx-here";
  set_config(s, server.id, c);
  stt = status(s, p.id);
  assert.ok(stt.problem!.includes("no-such-uvx-here isn't on this host's PATH"), JSON.stringify(stt));
});

test("a_profile_whose_assistant_is_elsewhere_has_its_google_there", async () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  assert.equal((await call(s, "GET", "/api/profiles/nope/assistant/google"))[0], 404);
  db.run(s.db(), "UPDATE profiles SET assistant_host='elsewhere' WHERE id=?1", p.id);
  const url = `/api/profiles/${p.id}/assistant/google`;
  assert.equal((await call(s, "GET", url))[0], 409);
  assert.equal((await call(s, "POST", url))[0], 409);
  // Nothing was added here.
  assert.equal(agent_tools.global_mcp_server(s.db(), SERVER), null);
  // HA-165: an assistant this host has already is its own, whatever its profile says (a hub sent it here).
  db.run(s.db(), "UPDATE profiles SET assistant_host=NULL WHERE id=?1", p.id);
  get_or_create(s, p.id);
  db.run(s.db(), "UPDATE profiles SET assistant_host='elsewhere' WHERE id=?1", p.id);
  assert.equal((await call(s, "GET", url))[0], 200);
});

test("only_the_assistant_gets_the_google_server_not_the_profiles_projects", () => {
  const s = state();
  const p = db.insert_profile(s.db(), "personal", [], null);
  const project = db.insert_project(s.db(), {
    id: "pr",
    profile_id: p.id,
    name: "Site",
    key: "SIT",
    repo_path: "/main",
    scratch_path: "/s",
    worktrees_root: "/w",
    base_branch: null,
    use_worktrees: true,
  });
  const dir = testing.temp_dir();
  const google = agent_tools.add_global_mcp_server(s.db(), SERVER, test_config(dir, null));
  const other = agent_tools.add_global_mcp_server(s.db(), "notes", { command: "notes-mcp" });
  for (const id of [google.id, other.id]) agent_tools.set_profile_switch(s.db(), p.id, id, true);
  // The project's switch on too: still not.
  db.run(s.db(), "INSERT INTO agent_tool_switches (scope, scope_id, item_id, enabled) VALUES ('project',?1,?2,1)", project.id, google.id);
  let tools = agent_tools.for_preview(s, project.id);
  assert.ok("notes" in tools.mcp_servers && !(SERVER in tools.mcp_servers), JSON.stringify(Object.keys(tools.mcp_servers)));
  const assistant = get_or_create(s, p.id);
  tools = agent_tools.for_task_run(s, assistant, null);
  assert.ok(SERVER in tools.mcp_servers && "notes" in tools.mcp_servers, JSON.stringify(Object.keys(tools.mcp_servers)));
  // Codex gets it too, given longer to start.
  const codex = mcp_server_config(SERVER, tools.mcp_servers[SERVER], false, [], false);
  assert.deepEqual([codex.command, codex.startup_timeout_sec], [path_str(join(dir, "uvx")), 120]);
  assert.equal(codex.env[CREDENTIALS_ENV], path_str(join(dir, "credentials")));
});

// ---------- consent ----------

test("the_client_file_is_read_as_google_cloud_downloads_it", () => {
  const c = consent.read_client(CLIENT);
  assert.deepEqual([c.client_id, c.client_secret, c.web], ["id.apps.googleusercontent.com", "shh", false]);
  assert.deepEqual([c.auth_uri, c.token_uri], ["https://accounts.google.com/o/oauth2/auth", "https://oauth2.googleapis.com/token"]);
  const web = consent.read_client('{"web": {"client_id": "w", "client_secret": "s", "token_uri": "http://127.0.0.1:1/token"}}');
  assert.ok(web.web && web.token_uri === "http://127.0.0.1:1/token");
  for (const bad of ["nope", "{}", '{"installed": {"client_id": "x"}}', '{"installed": {"client_secret": "x"}}']) {
    assert.throws(() => consent.read_client(bad), Error, bad);
  }
});

test("the_consent_url_asks_for_offline_access_with_pkce", () => {
  const c = consent.read_client(CLIENT);
  const url = consent.consent_url(c, "http://127.0.0.1:8765/", "st", "verifier");
  const [base, qs] = url.split("?");
  assert.equal(base, "https://accounts.google.com/o/oauth2/auth");
  const q = new URLSearchParams(qs);
  const get = (k: string) => q.get(k) ?? "";
  assert.equal(get("redirect_uri"), "http://127.0.0.1:8765/");
  assert.deepEqual([get("access_type"), get("prompt"), get("response_type"), get("state")], ["offline", "consent", "code", "st"]);
  assert.equal(get("code_challenge_method"), "S256");
  // RFC 7636's example.
  assert.equal(consent.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.equal(get("code_challenge"), consent.challenge("verifier"));
  assert.deepEqual(get("scope").split(" "), SCOPES);
});

test("only_the_flows_own_redirect_is_taken", () => {
  assert.deepEqual(consent.read_callback("GET /?state=st&code=4%2Fabc&scope=x HTTP/1.1", "st"), { kind: "code", code: "4/abc" });
  assert.deepEqual(consent.read_callback("GET /?state=st&error=access_denied HTTP/1.1", "st"), { kind: "denied", error: "access_denied" });
  // Another flow's state, a favicon, a POST, nothing.
  for (const line of ["GET /?state=other&code=abc HTTP/1.1", "GET /favicon.ico HTTP/1.1", "POST /?state=st&code=abc HTTP/1.1", "GET /?code=abc HTTP/1.1", ""]) {
    assert.deepEqual(consent.read_callback(line, "st"), { kind: "other" }, line);
  }
});

function id_token(email: string): string {
  const b = (t: string) => Buffer.from(t).toString("base64url");
  return `${b('{"alg":"RS256"}')}.${b(JSON.stringify({ email, sub: "1" }))}.sig`;
}

test("credentials_are_written_as_workspace_mcp_reads_them_for_its_user_alone", () => {
  const c = consent.read_client(CLIENT);
  const now = Date.parse("2026-11-04T07:00:00Z");
  const token = {
    access_token: "at",
    expires_in: 3599,
    refresh_token: "rt",
    scope: "openid https://www.googleapis.com/auth/gmail.readonly",
    id_token: id_token("sam@example.com"),
  };
  const [email, v] = consent.credentials_json(c, token, now);
  assert.equal(email, "sam@example.com");
  assert.deepEqual(v, {
    token: "at",
    refresh_token: "rt",
    token_uri: "https://oauth2.googleapis.com/token",
    client_id: "id.apps.googleusercontent.com",
    client_secret: "shh",
    scopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"],
    expiry: "2026-11-04T07:59:59",
  });
  // Without a refresh token it's no use to a server that runs for longer than an hour.
  const { refresh_token: _, ...no_refresh } = token;
  assert.throws(() => consent.credentials_json(c, no_refresh, now), /no refresh token/);
  const dir = testing.temp_dir();
  const file = join(dir, "new", "credentials", "sam@example.com.json");
  consent.write_private(file, "{}");
  assert.equal(mode(file), 0o600);
  assert.equal(mode(dirname(file)), 0o700);
  // Written over, it stays private, and nothing's left beside it.
  chmodSync(file, 0o644);
  consent.write_private(file, '{"a":1}');
  assert.equal(mode(file), 0o600);
  assert.equal(readdirSync(dirname(file)).length, 1);
});

/**
 * A token endpoint like Google's: it takes `code` for the flow's tokens (checking the PKCE verifier against what the
 * browser was sent with) and the refresh token `rt`. Gives its URL, the forms it was sent, and a way to stop it.
 */
async function fake_google(): Promise<[string, URLSearchParams[], () => void]> {
  const seen: URLSearchParams[] = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      const get = (k: string) => form.get(k) ?? "";
      const ok =
        req.url === "/token" &&
        ((get("grant_type") === "authorization_code" && get("code") === "the-code" && get("code_verifier") !== "") ||
          (get("grant_type") === "refresh_token" && get("refresh_token") === "rt"));
      seen.push(form);
      res.setHeader("content-type", "application/json");
      if (!ok) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }));
      }
      const scope = SCOPES.filter((s) => !s.includes("drive")).join(" ");
      res.end(JSON.stringify({ access_token: "at", expires_in: 3599, refresh_token: "rt", scope, id_token: id_token("sam@example.com") }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return [`http://127.0.0.1:${(srv.address() as AddressInfo).port}/token`, seen, () => srv.close()];
}

test("signing_in_takes_the_browsers_code_to_googles_token_endpoint_and_keeps_the_tokens", async () => {
  const [token_uri, seen, stop] = await fake_google();
  try {
    const c = consent.read_client(JSON.stringify({ installed: { client_id: "id", client_secret: "shh", token_uri } }));
    const dir = join(testing.temp_dir(), "credentials");
    const listener = await consent.listen(0);
    let shown!: (v: [string, string]) => void;
    const got = new Promise<[string, string]>((r) => (shown = r));
    const flow = consent.sign_in(c, dir, listener, (url, redirect) => shown([url, redirect]));
    const browser = (async () => {
      // The URL, as the user would read it.
      const [url, redirect] = await got;
      const state = new URLSearchParams(url.split("?")[1]).get("state");
      // A stray request first, then another flow's answer: neither ends it.
      assert.equal((await fetch(`${redirect}favicon.ico`)).status, 404);
      assert.equal((await fetch(`${redirect}?state=nope&code=the-code`)).status, 404);
      const page = await (await fetch(`${redirect}?state=${state}&code=the-code`)).text();
      assert.ok(page.includes("Signed in"), page);
    })();
    const [signed_in] = await Promise.all([flow, browser]);
    assert.equal(signed_in.email, "sam@example.com");
    assert.equal(signed_in.file, join(dir, "sam@example.com.json"));
    // Drive was left unticked.
    assert.ok(signed_in.missing.every((s) => s.includes("drive")) && signed_in.missing.length === 3, JSON.stringify(signed_in.missing));
    const form = seen[0];
    assert.ok(form.get("redirect_uri")!.startsWith("http://127.0.0.1:") && form.get("client_secret") === "shh", form.toString());
    const v = JSON.parse(readFileSync(signed_in.file, "utf8"));
    assert.deepEqual([v.refresh_token, v.token_uri], ["rt", token_uri]);
    assert.equal(mode(signed_in.file), 0o600);
    // The card's check uses the refresh token once: it works, then it's been revoked.
    await consent.verify(signed_in.file, null);
    writeFileSync(signed_in.file, JSON.stringify(v).replace('"rt"', '"revoked"'));
    const err = await consent.verify(signed_in.file, null).then(
      () => "",
      (e) => err_str(e),
    );
    assert.ok(err.includes("sign in again") && err.includes("invalid_grant"), err);
  } finally {
    stop();
  }
});

test("a_denied_consent_ends_the_flow_and_says_so", async () => {
  const c = consent.read_client(CLIENT);
  const dir = testing.temp_dir();
  const listener = await consent.listen(0);
  let shown!: (v: [string, string]) => void;
  const got = new Promise<[string, string]>((r) => (shown = r));
  const flow = consent.sign_in(c, dir, listener, (url, redirect) => shown([url, redirect]));
  const browser = (async () => {
    const [url, redirect] = await got;
    const state = url.split("state=")[1].split("&")[0];
    await fetch(`${redirect}?state=${state}&error=access_denied`);
  })();
  const [r] = await Promise.allSettled([flow, browser]);
  assert.equal(r.status, "rejected");
  assert.ok(String((r as PromiseRejectedResult).reason?.message).includes("access_denied"));
  assert.equal(readdirSync(dir).length, 0);
});
