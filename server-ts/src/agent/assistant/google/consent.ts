// Port of server/src/agent/assistant/google/consent.rs (HA-125, on the HA-117 branch).
/**
 * `huntaway google-auth`: the Google consent step on a headless assistant host.
 *
 * It's Google's loopback flow for a Desktop app client, with PKCE: it listens on `127.0.0.1:<port>` (8765 by default) on
 * the host, and prints Google's consent URL, whose redirect is that address. With the port forwarded to the user's machine
 * (`ssh -L 8765:127.0.0.1:8765 <host>`), the browser there opens the URL, the user signs in and agrees, and Google sends
 * the browser back to the forwarded port with a code, which this exchanges for tokens. It writes them as workspace-mcp
 * keeps its credentials (`<credentials dir>/<email>.json`, readable by the host's user alone), so the Google server
 * (google.ts) uses them from its next start.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync, constants } from "node:fs";
import { STATUS_CODES } from "node:http";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { context } from "../../../util.ts";
import { CONSENT_PORT, SCOPES, credentials_file, default_client_secret, default_credentials_dir } from "../google.ts";

const AUTH_URI = "https://accounts.google.com/o/oauth2/auth";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
/** How long it waits for the browser to come back, in milliseconds. */
const WAIT = 15 * 60_000;

/** An OAuth client, from the JSON Google Cloud's console downloads for it. */
export interface Client {
  client_id: string;
  client_secret: string;
  auth_uri: string;
  token_uri: string;
  /** A Web application client rather than a Desktop app one: it takes only the redirects registered for it. */
  web: boolean;
}

/** The client in a `client_secret.json` (`{"installed": {…}}` for a Desktop app client, `{"web": {…}}` for a Web one). */
export function read_client(text: string): Client {
  let v: any;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw context("the client secret file isn't JSON", e);
  }
  const is_obj = (x: any) => x !== null && typeof x === "object";
  let c: any, web: boolean;
  if (is_obj(v) && Object.hasOwn(v, "installed")) [c, web] = [v.installed, false];
  else if (is_obj(v) && Object.hasOwn(v, "web")) [c, web] = [v.web, true];
  else throw new Error('the client secret file has no "installed" (Desktop app) or "web" client in it');
  const field = (k: string): string | null => (typeof c?.[k] === "string" && c[k].trim() !== "" ? c[k].trim() : null);
  const client_id = field("client_id");
  if (client_id === null) throw new Error("the client secret file has no client_id");
  const client_secret = field("client_secret");
  if (client_secret === null) throw new Error("the client secret file has no client_secret");
  return { client_id, client_secret, auth_uri: field("auth_uri") ?? AUTH_URI, token_uri: field("token_uri") ?? TOKEN_URI, web };
}

function read_client_file(path: string): Client {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw context(`reading the OAuth client from ${path}`, e);
  }
  try {
    return read_client(text);
  } catch (e) {
    throw context(`in ${path}`, e);
  }
}

/** A random URL-safe string of `bytes` random bytes. */
function random(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

/** PKCE's S256 challenge for a verifier. */
export function challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** The consent URL: offline access (for a refresh token), and the consent screen every time, so Google gives a new one. */
export function consent_url(c: Client, redirect: string, state: string, verifier: string): string {
  const q = new URLSearchParams([
    ["client_id", c.client_id],
    ["redirect_uri", redirect],
    ["response_type", "code"],
    ["scope", SCOPES.join(" ")],
    ["access_type", "offline"],
    ["prompt", "consent"],
    ["include_granted_scopes", "true"],
    ["state", state],
    ["code_challenge", challenge(verifier)],
    ["code_challenge_method", "S256"],
  ]);
  return `${c.auth_uri}?${q}`;
}

/** What the browser brought back to the redirect: the code, Google's error, or `other` (not the redirect, or another flow's). */
export type Callback = { kind: "code"; code: string } | { kind: "denied"; error: string } | { kind: "other" };

/** Reads a request's first line (`GET /?state=…&code=… HTTP/1.1`) for the redirect's answer, if its state is `state`. */
export function read_callback(request_line: string, state: string): Callback {
  const parts = request_line.split(/\s+/).filter((p) => p !== "");
  if (parts[0] !== "GET" || parts[1] === undefined) return { kind: "other" };
  const target = parts[1];
  const i = target.indexOf("?");
  const [path, query] = i < 0 ? [target, ""] : [target.slice(0, i), target.slice(i + 1)];
  if (path !== "/") return { kind: "other" };
  const q = new URLSearchParams(query);
  if (q.get("state") !== state) return { kind: "other" };
  const code = q.get("code");
  const error = q.get("error");
  if (code !== null && code !== "") return { kind: "code", code };
  if (error !== null) return { kind: "denied", error };
  return { kind: "other" };
}

/**
 * The account an ID token is for: its `email` claim. It came from Google's token endpoint over TLS, so it isn't checked
 * again here.
 */
export function id_token_email(id_token: string): string | null {
  const payload = id_token.split(".")[1];
  if (payload === undefined) return null;
  const b64 = payload.replace(/=+$/, "");
  if (!/^[A-Za-z0-9_-]*$/.test(b64)) return null;
  try {
    const v = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    return typeof v?.email === "string" ? v.email : null;
  } catch {
    return null;
  }
}

/** Posts a form to the token endpoint, and gives its JSON answer or says why it failed. */
async function token_request(uri: string, form: Array<[string, string]>): Promise<any> {
  let res: Response;
  try {
    res = await fetch(uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw context(`reaching ${uri}`, e);
  }
  let v: any = null;
  try {
    v = await res.json();
  } catch {}
  if (!res.ok) {
    const why = [v?.error, v?.error_description].filter((x) => typeof x === "string").join(": ");
    throw new Error(`Google said ${res.status} ${STATUS_CODES[res.status] ?? ""}`.trimEnd() + (why ? ` (${why})` : ""));
  }
  return v;
}

/**
 * The credentials workspace-mcp reads (auth/credential_store.py): the tokens, the client, the scopes granted and when the
 * access token expires (a naive UTC time, as google-auth keeps it). `now` in milliseconds since the epoch.
 */
export function credentials_json(c: Client, token: any, now: number): [string, any] {
  const refresh = typeof token?.refresh_token === "string" && token.refresh_token !== "" ? token.refresh_token : null;
  if (refresh === null) {
    throw new Error("Google gave no refresh token. Remove the app's access at https://myaccount.google.com/permissions and sign in again.");
  }
  const email = typeof token?.id_token === "string" ? id_token_email(token.id_token) : null;
  if (email === null) throw new Error("Google didn't say which account this is (no email in its ID token)");
  const scopes: string[] = typeof token?.scope === "string" ? token.scope.split(/\s+/).filter((s: string) => s !== "") : [...SCOPES];
  const expiry = Number.isInteger(token?.expires_in) ? new Date(now + token.expires_in * 1000).toISOString().slice(0, 19) : null;
  return [
    email,
    {
      token: token.access_token ?? null,
      refresh_token: refresh,
      token_uri: c.token_uri,
      client_id: c.client_id,
      client_secret: c.client_secret,
      scopes,
      expiry,
    },
  ];
}

/**
 * Writes `content` to `path` readable by its owner alone, by way of a file beside it (so a reader never sees half of it),
 * in a folder made for the owner alone if it isn't there.
 */
export function write_private(path: string, content: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      throw context(`making ${dir}`, e);
    }
  }
  const tmp = join(dir, `.${basename(path)}.tmp`);
  rmSync(tmp, { force: true });
  let fd: number;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (e) {
    throw context(`writing ${tmp}`, e);
  }
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  try {
    renameSync(tmp, path);
  } catch (e) {
    throw context(`writing ${path}`, e);
  }
}

/** A loopback listener for `sign_in`, on `port` (0 for any free one). */
export function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", (e) => reject(context(`listening on 127.0.0.1:${port} (pick another with --port, and forward that one)`, e)));
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

/** Reads up to 8 KB of what the client sends first (for its request line), giving up after 10 seconds. */
function first_bytes(sock: Socket): Promise<string> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const done = () => {
      clearTimeout(timer);
      sock.off("data", on_data);
      resolve(buf.subarray(0, 8192).toString("utf8"));
    };
    const on_data = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 8192 || buf.includes("\n")) done();
    };
    const timer = setTimeout(done, 10_000);
    sock.on("data", on_data);
    sock.once("end", done);
    sock.once("error", done);
  });
}

/** Waits on `listener` for the browser to come back from the consent screen with this flow's `state`, answering each request. */
function wait_for_code(listener: Server, state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    listener.on("connection", (sock) => {
      sock.on("error", () => {});
      void first_bytes(sock).then((text) => {
        const line = text.split(/\r?\n/)[0] ?? "";
        const cb = read_callback(line, state);
        let status: string, body: string;
        if (cb.kind === "code") [status, body] = ["200 OK", "Signed in. You can close this tab and go back to the terminal."];
        else if (cb.kind === "denied") [status, body] = ["200 OK", "Google didn't sign you in. See the terminal."];
        else [status, body] = ["404 Not Found", "Not found."];
        const page = `<!doctype html><meta charset=utf-8><title>Huntaway</title><p style="font:16px system-ui;margin:3em">${body}</p>`;
        const reply = `HTTP/1.1 ${status}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(page)}\r\nconnection: close\r\n\r\n${page}`;
        sock.end(reply);
        if (settled || cb.kind === "other") return;
        settled = true;
        if (cb.kind === "code") resolve(cb.code);
        else reject(new Error(`Google said: ${cb.error}`));
      });
    });
  });
}

/** `huntaway google-auth [--client-secret <file>] [--credentials-dir <dir>] [--port <port>]`'s arguments. */
export function parse_args(args: string[]): { client_secret: string | null; credentials_dir: string | null; port: number } {
  const out = { client_secret: null as string | null, credentials_dir: null as string | null, port: CONSENT_PORT };
  for (let i = 0; i < args.length; i++) {
    let [k, v] = args[i].includes("=") ? [args[i].slice(0, args[i].indexOf("=")), args[i].slice(args[i].indexOf("=") + 1)] : [args[i], undefined as string | undefined];
    const value = () => {
      v ??= args[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      return v;
    };
    if (k === "--client-secret") out.client_secret = value();
    else if (k === "--credentials-dir") out.credentials_dir = value();
    else if (k === "--port") {
      const p = value();
      if (!/^\d+$/.test(p) || Number(p) > 65535) throw new Error(`invalid port ${JSON.stringify(p)}`);
      out.port = Number(p);
    } else if (k === "--help" || k === "-h") {
      console.log(
        "Usage: huntaway google-auth [--client-secret <file>] [--credentials-dir <dir>] [--port <port>]\n\n" +
          "Sign in to Google for the assistant's Google server (Gmail, Calendar, Drive), on a headless host: it listens on\n" +
          `127.0.0.1:<port> (${CONSENT_PORT}), which you forward with \`ssh -L\`, and keeps the token in ~/.google_workspace_mcp/credentials.\n\n` +
          "  --client-secret <file>    The OAuth client's JSON, downloaded from Google Cloud (a Desktop app client)\n" +
          "  --credentials-dir <dir>   Where to keep the credentials (workspace-mcp's WORKSPACE_MCP_CREDENTIALS_DIR)\n" +
          `  --port <port>             The port to listen on (default ${CONSENT_PORT})`,
      );
      process.exit(0);
    } else throw new Error(`unexpected argument '${args[i]}'`);
  }
  return out;
}

/** `huntaway google-auth`: sign in to Google for the assistant's Google server (see the module's doc). */
export async function run(args: string[]): Promise<void> {
  const a = parse_args(args);
  const secret_path = a.client_secret ?? default_client_secret();
  const client = read_client_file(secret_path);
  const creds_dir = a.credentials_dir ?? default_credentials_dir();
  const listener = await listen(a.port);
  const port = (listener.address() as AddressInfo).port;
  const host = hostname();
  console.log(`Signing in to Google for the assistant's Google server, with the OAuth client in ${secret_path}.`);
  const signed_in = await sign_in(client, creds_dir, listener, (url, redirect) => {
    if (client.web) {
      console.log(
        `\nThat's a Web application client: Google sends the browser back only to its registered redirect URIs, so add ${redirect} to them (or use a Desktop app client).`,
      );
    }
    console.log(`\n1. Forward this port from the machine your browser is on, if you haven't (in another terminal there):\n\n     ssh -N -L ${port}:127.0.0.1:${port} ${host}\n`);
    console.log(`2. Open this in that browser, sign in and allow access:\n\n     ${url}\n`);
    console.log(`Waiting for Google to send the browser back to ${redirect} (up to ${WAIT / 60_000} minutes)…`);
  });
  console.log(`\nSigned in as ${signed_in.email}. Its credentials are in ${signed_in.file} (readable by you alone).`);
  if (signed_in.missing.length) {
    console.log(`Google didn't grant all it was asked for (some boxes were left unticked): ${signed_in.missing.join(", ")}. Run this again to give them.`);
  }
  console.log("The assistant's Google card shows it as connected. The Google server picks it up from its next run.");
}

/** Who `sign_in` signed in, where their credentials are, and the scopes Google didn't grant. */
export interface SignedIn {
  email: string;
  file: string;
  missing: string[];
}

/**
 * The flow itself: `show` is given the consent URL and the redirect, then it waits on `listener` (which it closes when it's
 * done) for the browser, swaps the code for tokens and writes them to `creds_dir`.
 */
export async function sign_in(client: Client, creds_dir: string, listener: Server, show: (url: string, redirect: string) => void): Promise<SignedIn> {
  try {
    const redirect = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/`;
    const [state, verifier] = [random(24), random(48)];
    show(consent_url(client, redirect, state, verifier), redirect);
    let timer: NodeJS.Timeout | undefined;
    const gave_up = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("gave up waiting for the browser")), WAIT);
    });
    let code: string;
    try {
      code = await Promise.race([wait_for_code(listener, state), gave_up]);
    } finally {
      clearTimeout(timer);
    }
    let token: any;
    try {
      token = await token_request(client.token_uri, [
        ["code", code],
        ["client_id", client.client_id],
        ["client_secret", client.client_secret],
        ["redirect_uri", redirect],
        ["grant_type", "authorization_code"],
        ["code_verifier", verifier],
      ]);
    } catch (e) {
      throw context("exchanging Google's code for tokens", e);
    }
    const [email, creds] = credentials_json(client, token, Date.now());
    const file = join(creds_dir, credentials_file(email));
    write_private(file, JSON.stringify(creds, null, 2));
    const granted: string[] = creds.scopes;
    return { email, file, missing: SCOPES.filter((s) => !granted.includes(s)) };
  } finally {
    listener.close();
  }
}

/** Checks that an account's refresh token still works, by using it once (the token it gets isn't kept). */
export async function verify(credentials: string, client_secret: string | null): Promise<void> {
  let text: string;
  try {
    text = readFileSync(credentials, "utf8");
  } catch (e) {
    throw context(`reading ${credentials}`, e);
  }
  const v = JSON.parse(text);
  const refresh = typeof v?.refresh_token === "string" ? v.refresh_token : null;
  if (refresh === null) throw new Error("its credentials have no refresh token");
  let from_file: Client | null = null;
  if (client_secret !== null) {
    try {
      from_file = read_client_file(client_secret);
    } catch {}
  }
  const id = typeof v.client_id === "string" ? v.client_id : from_file?.client_id;
  if (id == null) throw new Error("no client id");
  const secret = typeof v.client_secret === "string" ? v.client_secret : from_file?.client_secret;
  if (secret == null) throw new Error("no client secret");
  const uri = typeof v.token_uri === "string" ? v.token_uri : TOKEN_URI;
  try {
    await token_request(uri, [
      ["refresh_token", refresh],
      ["client_id", id],
      ["client_secret", secret],
      ["grant_type", "refresh_token"],
    ]);
  } catch (e) {
    throw context("Google turned its refresh token away: sign in again", e);
  }
}

function hostname(): string {
  try {
    const h = readFileSync("/etc/hostname", "utf8").trim();
    if (h !== "") return h;
  } catch {}
  return "<this host>";
}
