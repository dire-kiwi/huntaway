/**
 * Hosted docs (HA-282): a profile connects to a hosted docs site (dire-kiwi/docs, https://docs.nest.dire.nz by default)
 * and publishes its local documents (db/docs.ts) there, from the board's Docs page.
 *
 * - Connecting is the site's OAuth device authorization grant (RFC 8628): this host registers a public client with the
 *   site once (`/oauth/register`, no redirect URIs), starts a sign-in (`/oauth/device_authorization`), and the board
 *   shows the user its code and link while this host polls the token endpoint (honouring `interval` and `slow_down`).
 *   The access token lasts an hour and is renewed with the refresh token, which rotates on every use. The fallback is a
 *   personal access token the user pastes (the site's **Access** page).
 * - Publishing calls the site's `/mcp` `publish_document` tool (JSON-RPC over Streamable HTTP, with the bearer token)
 *   with a local version's pages, and remembers where it went and as whom (db/docs_site.ts), so publishing again adds a
 *   version to the same remote document. Before a document's first publish to a slug, the board can ask whether the site
 *   has a document there already (`ask`, HA-286), so it isn't added to without the user's say-so.
 *
 * The tokens stay on this host: the API only says whether a profile is connected, and as whom. Nothing logs them, nor
 * the device code.
 */
import * as db from "../db.ts";
import { ApiError } from "../http.ts";
import type { Shared } from "../state.ts";
import { background } from "../util.ts";

export const DEFAULT_SITE = "https://docs.nest.dire.nz";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const PROTOCOL_VERSION = "2025-06-18";

/** How long a request to the site may take, and the poll's back-off on `slow_down` (seconds), which tests shorten. */
export const timing = { request_ms: 20_000, slow_down_s: 5, default_interval_s: 5 };

/** A site's address as it's kept: http(s), no credentials, query or fragment, and no `/` at the end. */
export function site_url(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_SITE;
  if (typeof raw !== "string") throw ApiError.bad("site_url must be a string");
  const t = raw.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    throw ApiError.bad(`${JSON.stringify(raw)} isn't a URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw ApiError.bad("the docs site's URL starts with https:// (or http://)");
  if (u.username || u.password || u.search || u.hash) throw ApiError.bad("the docs site's URL has no user, query or fragment");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** Whether a URL the site gave (that the board opens or links) is a web page's, not `javascript:` or the like. */
const web_url = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//i.test(v);

/** The site's name for messages: its host. */
const site_name = (site: string) => new URL(site).host;

/** A site's reply: its status and JSON body (null if it isn't JSON). */
interface Reply {
  status: number;
  body: any;
  headers: Headers;
  text: string;
}

async function request(site: string, url: string, init: RequestInit): Promise<Reply> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timing.request_ms) });
  } catch (e: any) {
    throw new ApiError(502, `couldn't reach ${site_name(site)}: ${e?.cause?.message ?? e?.message ?? String(e)}`);
  }
  const text = await res.text().catch(() => "");
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body, headers: res.headers, text };
}

const post_form = (site: string, url: string, form: Record<string, string>) =>
  request(site, url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form),
  });

/** An OAuth error reply's text (`error_description`, else `error`, else the status). */
const oauth_text = (r: Reply) => r.body?.error_description ?? r.body?.error ?? `HTTP ${r.status}`;

interface Metadata {
  token_endpoint: string;
  registration_endpoint: string;
  device_authorization_endpoint: string;
}

/** The site's endpoints, from its `/.well-known/oauth-authorization-server`. */
async function metadata(site: string): Promise<Metadata> {
  const r = await request(site, `${site}/.well-known/oauth-authorization-server`, { headers: { accept: "application/json" } });
  const m = r.body;
  const ok = (k: string) => typeof m?.[k] === "string" && /^https?:\/\//.test(m[k]);
  if (r.status !== 200 || !ok("token_endpoint") || !ok("registration_endpoint")) {
    throw new ApiError(502, `${site_name(site)} doesn't look like a docs site (no OAuth metadata at /.well-known/oauth-authorization-server)`);
  }
  if (!ok("device_authorization_endpoint")) throw new ApiError(502, `${site_name(site)} doesn't offer the device sign-in: paste an access token instead`);
  return m;
}

/** This host's OAuth client on the site: the one it registered, or a new one (`again`: the site forgot the old one). */
async function client_id(s: Shared, site: string, m: Metadata, again = false): Promise<string> {
  const known = again ? null : db.docs_site_client(s.db(), site);
  if (known) return known;
  const r = await request(site, m.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_name: `Huntaway (${s.host_name})`, grant_types: [DEVICE_GRANT, "refresh_token"] }),
  });
  if ((r.status !== 200 && r.status !== 201) || typeof r.body?.client_id !== "string") {
    throw new ApiError(502, `${site_name(site)} didn't register this host: ${oauth_text(r)}`);
  }
  db.set_docs_site_client(s.db(), site, r.body.client_id);
  return r.body.client_id;
}

/** A device sign-in under way: what the user is shown, and what this host polls with. */
interface Pending {
  site_url: string;
  client_id: string;
  token_endpoint: string;
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string | null;
  /** Milliseconds since the epoch. */
  expires_at: number;
  interval_s: number;
  timer: NodeJS.Timeout | null;
  /** Why it stopped (denied, expired, failed), until the user starts again or closes it. */
  error: string | null;
}

/**
 * Each state's sign-ins under way, by profile, its tokens' refreshes in flight, its publishes in flight by document, and
 * the site each profile was last connected to (HA-286: so that after a disconnect it's still the one shown).
 */
const state = new WeakMap<
  Shared,
  {
    pending: Map<string, Pending>;
    refreshing: Map<string, Promise<db.DocsSiteConnection>>;
    publishing: Map<string, Promise<unknown>>;
    last_site: Map<string, string>;
  }
>();
function mine(s: Shared) {
  let st = state.get(s);
  if (!st) state.set(s, (st = { pending: new Map(), refreshing: new Map(), publishing: new Map(), last_site: new Map() }));
  return st;
}

const changed = (s: Shared, profile_id: string) => s.emit({ type: "docs_site", profile_id });

/** Forget the profile's connection (or, with `access_token`, only if it's still the one with that token), keeping its site. */
function forget(s: Shared, profile_id: string, access_token?: string) {
  const c = db.docs_site_connection(s.db(), profile_id);
  if (db.delete_docs_site_connection(s.db(), profile_id, access_token) && c) mine(s).last_site.set(profile_id, c.site_url);
}

/** The profile's site: the one it's connected to (or signing in to), else the one it was last, else the default. */
function site_of(s: Shared, profile_id: string, c = db.docs_site_connection(s.db(), profile_id)): string {
  return c?.site_url ?? mine(s).pending.get(profile_id)?.site_url ?? mine(s).last_site.get(profile_id) ?? DEFAULT_SITE;
}

/** What the board is shown of a profile's connection: never its tokens. */
export function status(s: Shared, profile_id: string) {
  const c = db.docs_site_connection(s.db(), profile_id);
  const p = mine(s).pending.get(profile_id);
  return {
    default_site_url: DEFAULT_SITE,
    site_url: site_of(s, profile_id, c),
    connected: !!c,
    kind: c?.kind ?? null,
    login: c?.login ?? null,
    connected_at: c?.connected_at ?? null,
    pending: p
      ? {
          site_url: p.site_url,
          user_code: p.user_code,
          verification_uri: p.verification_uri,
          verification_uri_complete: p.verification_uri_complete,
          expires_at: new Date(p.expires_at).toISOString(),
          error: p.error,
        }
      : null,
  };
}

function stop_pending(s: Shared, profile_id: string) {
  const p = mine(s).pending.get(profile_id);
  if (p?.timer) clearTimeout(p.timer);
  mine(s).pending.delete(profile_id);
}

/** Start a device sign-in to `site` for the profile (stopping any it had under way). */
export async function start_device(s: Shared, profile_id: string, site: string) {
  stop_pending(s, profile_id);
  const m = await metadata(site);
  let id = await client_id(s, site, m);
  let r = await post_form(site, m.device_authorization_endpoint, { client_id: id });
  if (r.body?.error === "invalid_client") {
    // The site has forgotten this host's client (its database was reset, say): register again.
    id = await client_id(s, site, m, true);
    r = await post_form(site, m.device_authorization_endpoint, { client_id: id });
  }
  const b = r.body;
  if (r.status !== 200 || typeof b?.device_code !== "string" || typeof b?.user_code !== "string" || !web_url(b?.verification_uri)) {
    throw new ApiError(502, `${site_name(site)} didn't start a sign-in: ${oauth_text(r)}`);
  }
  const p: Pending = {
    site_url: site,
    client_id: id,
    token_endpoint: m.token_endpoint,
    device_code: b.device_code,
    user_code: b.user_code,
    verification_uri: b.verification_uri,
    verification_uri_complete: web_url(b.verification_uri_complete) ? b.verification_uri_complete : null,
    expires_at: Date.now() + (Number(b.expires_in) > 0 ? Number(b.expires_in) : 600) * 1000,
    interval_s: Number(b.interval) > 0 ? Number(b.interval) : timing.default_interval_s,
    timer: null,
    error: null,
  };
  mine(s).pending.set(profile_id, p);
  schedule(s, profile_id, p);
  changed(s, profile_id);
  return status(s, profile_id);
}

function schedule(s: Shared, profile_id: string, p: Pending) {
  p.timer = setTimeout(() => background("polling the docs site's sign-in", poll(s, profile_id, p)), p.interval_s * 1000);
  p.timer.unref();
}

/** One poll of the token endpoint for a sign-in, then the next unless it's done. */
async function poll(s: Shared, profile_id: string, p: Pending) {
  p.timer = null;
  const current = () => mine(s).pending.get(profile_id) === p;
  const fail = (why: string) => {
    if (!current()) return;
    p.error = why;
    changed(s, profile_id);
  };
  if (!current()) return;
  if (Date.now() >= p.expires_at) return fail("The sign-in code expired before it was approved. Start again.");
  let r: Reply;
  try {
    r = await post_form(p.site_url, p.token_endpoint, { grant_type: DEVICE_GRANT, device_code: p.device_code, client_id: p.client_id });
  } catch {
    // The site is unreachable for now: try again at the next interval, until the code expires.
    if (current()) schedule(s, profile_id, p);
    return;
  }
  if (!current()) return;
  const error = r.body?.error;
  if (r.status === 200 && typeof r.body?.access_token === "string") {
    mine(s).pending.delete(profile_id);
    db.set_docs_site_connection(s.db(), {
      profile_id,
      site_url: p.site_url,
      kind: "oauth",
      access_token: r.body.access_token,
      refresh_token: typeof r.body.refresh_token === "string" ? r.body.refresh_token : null,
      expires_at: expiry(r.body.expires_in),
      login: null,
    });
    changed(s, profile_id);
    background("finding the docs site's username", learn_login(s, profile_id));
    return;
  }
  if (error === "authorization_pending" || error === "slow_down" || r.status >= 500) {
    if (error === "slow_down") p.interval_s += timing.slow_down_s;
    schedule(s, profile_id, p);
    return;
  }
  if (error === "access_denied") return fail("The sign-in was denied on the docs site.");
  if (error === "expired_token") return fail("The sign-in code expired before it was approved. Start again.");
  fail(`The sign-in failed: ${oauth_text(r)}`);
}

const expiry = (expires_in: unknown) => (Number(expires_in) > 0 ? Date.now() + Number(expires_in) * 1000 : null);

/** Stop a sign-in under way (or clear the error of one that stopped). */
export function cancel_device(s: Shared, profile_id: string) {
  stop_pending(s, profile_id);
  changed(s, profile_id);
}

/** Connect with a personal access token, once the site takes it. */
export async function connect_token(s: Shared, profile_id: string, site: string, token: unknown) {
  if (typeof token !== "string" || token.trim() === "") throw ApiError.bad("paste an access token");
  const t = token.trim();
  const r = await rpc(site, t, "tools/call", { name: "list_documents", arguments: {} });
  if (r.status === 401) throw ApiError.bad(`${site_name(site)} doesn't take that token (it may have been revoked or have expired)`);
  const out = tool_result(site, r);
  stop_pending(s, profile_id);
  db.set_docs_site_connection(s.db(), {
    profile_id,
    site_url: site,
    kind: "token",
    access_token: t,
    refresh_token: null,
    expires_at: null,
    login: owner(out.v),
  });
  changed(s, profile_id);
  return status(s, profile_id);
}

/** Forget the profile's connection (its tokens stay valid on the site until they expire, or the user revokes them there). */
export function disconnect(s: Shared, profile_id: string) {
  stop_pending(s, profile_id);
  forget(s, profile_id);
  changed(s, profile_id);
  return status(s, profile_id);
}

/** The username in `list_documents`' answer: the owner of a document that isn't someone else's. */
function owner(v: any): string | null {
  const own = Array.isArray(v?.documents) ? v.documents.find((d: any) => d?.shared_with_you === false && typeof d?.owner === "string") : undefined;
  return own?.owner ?? null;
}

/** Find the profile's username on the site, from its documents (the site has no other way to ask yet). */
async function learn_login(s: Shared, profile_id: string, slug?: string) {
  const c = db.docs_site_connection(s.db(), profile_id);
  if (!c || c.login) return;
  const out = slug === undefined ? await call_tool(s, profile_id, "list_documents", {}) : await call_tool(s, profile_id, "get_document", { slug });
  const login = slug === undefined ? owner(out) : typeof out?.owner === "string" ? out.owner : null;
  const now = db.docs_site_connection(s.db(), profile_id);
  if (!login || !now) return;
  db.set_docs_site_login(s.db(), profile_id, now.access_token, login);
  changed(s, profile_id);
}

/** A JSON-RPC request to the site's MCP endpoint. */
async function rpc(site: string, token: string, method: string, params: any): Promise<Reply> {
  const r = await request(site, `${site}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (r.body === null && (r.headers.get("content-type") ?? "").includes("text/event-stream")) {
    // A Streamable HTTP server may answer as a stream of events: the answer is the one with the request's id.
    for (const line of r.text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const m = JSON.parse(line.slice(5));
        if (m?.id === 1) r.body = m;
      } catch {}
    }
  }
  return r;
}

/** A tool's error answer (a 400 with the site's message), and its text as the site gave it. */
class ToolFailed extends ApiError {
  text: string;
  constructor(message: string, text: string) {
    super(400, message);
    this.text = text;
  }
}

/** A `tools/call`'s result: its JSON (or text), or the tool's error as a 400 with the site's message. */
function tool_result(site: string, r: Reply): { v: any; text: string } {
  if (r.status !== 200 || !r.body)
    throw new ApiError(502, `${site_name(site)} answered HTTP ${r.status}: ${(r.body?.error_description ?? r.text).slice(0, 300)}`);
  if (r.body.error) throw new ApiError(502, `${site_name(site)}: ${r.body.error.message ?? JSON.stringify(r.body.error)}`);
  const res = r.body.result ?? {};
  const text = Array.isArray(res.content) ? res.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("\n") : "";
  if (res.isError) throw new ToolFailed(`${site_name(site)}: ${text || "the tool failed"}`, text);
  let v = res.structuredContent;
  if (v === undefined) {
    try {
      v = JSON.parse(text);
    } catch {
      v = text;
    }
  }
  return { v, text };
}

/** Renew the profile's access token with its refresh token; calls at once share one (the token rotates). */
function refresh(s: Shared, profile_id: string, c: db.DocsSiteConnection): Promise<db.DocsSiteConnection> {
  const st = mine(s);
  let p = st.refreshing.get(profile_id);
  if (!p) {
    p = (async () => {
      // Renewed (or connected again) since `c` was read: those tokens are the ones to use.
      const latest = db.docs_site_connection(s.db(), profile_id);
      if (!latest) throw not_connected(c.site_url);
      if (latest.access_token !== c.access_token) return latest;
      const used = c.refresh_token!;
      const m = await metadata(c.site_url);
      const id = db.docs_site_client(s.db(), c.site_url);
      const r = await post_form(c.site_url, m.token_endpoint, { grant_type: "refresh_token", refresh_token: used, ...(id ? { client_id: id } : {}) });
      if (r.status === 200 && typeof r.body?.access_token === "string") {
        const rt = typeof r.body.refresh_token === "string" ? r.body.refresh_token : used;
        db.refresh_docs_site_tokens(s.db(), profile_id, used, r.body.access_token, rt, expiry(r.body.expires_in));
        const now = db.docs_site_connection(s.db(), profile_id);
        if (!now) throw not_connected(c.site_url);
        return now;
      }
      if (r.status === 400 || r.status === 401) {
        // Expired, revoked, or the user is no longer allowed: the profile has to sign in again.
        forget(s, profile_id, c.access_token);
        changed(s, profile_id);
        throw ApiError.conflict(`The sign-in to ${site_name(c.site_url)} has expired or was revoked (${oauth_text(r)}): connect again.`);
      }
      throw new ApiError(502, `${site_name(c.site_url)} didn't renew the sign-in: ${oauth_text(r)}`);
    })().finally(() => st.refreshing.delete(profile_id));
    st.refreshing.set(profile_id, p);
  }
  return p;
}

const not_connected = (site: string) => ApiError.conflict(`Connect this profile to ${site_name(site)} first.`);

/** Call one of the site's MCP tools as the profile, renewing its sign-in as needed. Its result's JSON (or text). */
export async function call_tool(s: Shared, profile_id: string, name: string, args: any): Promise<any> {
  let c = db.docs_site_connection(s.db(), profile_id);
  if (!c) throw not_connected(DEFAULT_SITE);
  if (c.refresh_token && c.expires_at !== null && c.expires_at - 60_000 < Date.now()) c = await refresh(s, profile_id, c);
  let r = await rpc(c.site_url, c.access_token, "tools/call", { name, arguments: args });
  if (r.status === 401 && c.refresh_token) {
    c = await refresh(s, profile_id, c);
    r = await rpc(c.site_url, c.access_token, "tools/call", { name, arguments: args });
  }
  if (r.status === 401) {
    forget(s, profile_id, c.access_token);
    changed(s, profile_id);
    const why = r.body?.error_description ?? "the token is invalid or expired";
    throw ApiError.conflict(`${site_name(c.site_url)} no longer accepts this profile's sign-in (${why}): connect again.`);
  }
  return tool_result(c.site_url, r).v;
}

/** Whether a document was published as another account than the one connected (as far as is known: either may not be). */
const other_account = (p: db.DocsSitePublished, c: db.DocsSiteConnection) => p.login !== null && c.login !== null && p.login !== c.login;

/**
 * The document's publish state on the profile's site (the one it's connected to, else the one it was last, else the
 * default): none if it was published there as another account (HA-286).
 */
export function published(s: Shared, profile_id: string, doc_id: string): db.DocsSitePublished | null {
  const c = db.docs_site_connection(s.db(), profile_id);
  const p = db.docs_site_published(s.db(), doc_id, site_of(s, profile_id, c));
  return p && c && other_account(p, c) ? null : p;
}

/** How to publish: the remote slug (`slug`), and whether to ask first if the site has a document there (`ask`). */
export interface PublishOptions {
  slug?: unknown;
  ask?: unknown;
}

/**
 * Publish version `number` (null: the latest) of the profile's document `slug` to its site: as a new version of the
 * remote document it was published to before, or, the first time (or with a remote slug other than that one's), to
 * `o.slug` (by default the local slug). With `o.ask`, a publish to a slug the document wasn't published to before first
 * looks it up: if the site has a document there of the user's, it answers `{exists}` rather than add a version to it,
 * for the user to confirm (publishing again without `ask`) or choose another slug; if it's another user's, it says so.
 * Publishes of one document go one at a time.
 */
export async function publish(s: Shared, profile_id: string, slug: string, number: number | null, o: PublishOptions = {}) {
  const d = db.get_doc(s.db(), profile_id, slug);
  if (!d) throw ApiError.not_found("document");
  const st = mine(s);
  const before = st.publishing.get(d.id) ?? Promise.resolve();
  const p = before.catch(() => {}).then(() => publish_now(s, profile_id, d, number, o));
  st.publishing.set(d.id, p);
  try {
    return await p;
  } finally {
    if (st.publishing.get(d.id) === p) st.publishing.delete(d.id);
  }
}

/** Find the profile's username if it isn't known yet, quietly: a publish goes on without it. */
async function try_learn_login(s: Shared, profile_id: string, slug?: string) {
  if (db.docs_site_connection(s.db(), profile_id)?.login) return;
  try {
    await learn_login(s, profile_id, slug);
  } catch {}
}

/** The site's document at `slug`, if it has one the user can see, and whether it's another user's. */
async function remote_doc(s: Shared, profile_id: string, slug: string): Promise<{ v: any; theirs: boolean } | null> {
  let v: any;
  try {
    v = await call_tool(s, profile_id, "get_document", { slug });
  } catch (e) {
    if (e instanceof ToolFailed && e.text.startsWith("no document")) return null;
    throw e;
  }
  const login = db.docs_site_connection(s.db(), profile_id)?.login ?? null;
  // The site gives its owner `sharing` (null for others), and names the owner.
  const theirs = typeof v?.owner === "string" && (login !== null ? v.owner !== login : v.sharing === null);
  return { v, theirs };
}

async function publish_now(s: Shared, profile_id: string, d: db.Doc, number: number | null, o: PublishOptions) {
  if (!db.docs_site_connection(s.db(), profile_id)) throw not_connected(DEFAULT_SITE);
  const v = db.doc_version(s.db(), d.id, number);
  if (!v) throw ApiError.not_found("version");
  const remote_slug = o.slug;
  if (remote_slug !== undefined && remote_slug !== null && remote_slug !== "" && typeof remote_slug !== "string") throw ApiError.bad("slug must be a string");
  // Who's connected, to tell a document published as another account (one connected before, say) from this one's.
  await try_learn_login(s, profile_id);
  const c = db.docs_site_connection(s.db(), profile_id);
  if (!c) throw not_connected(DEFAULT_SITE);
  const known = db.docs_site_published(s.db(), d.id, c.site_url);
  const before = known && !other_account(known, c) ? known : null;
  // Another slug than the one it went to re-targets it: a remote document that was deleted and taken by someone else,
  // say, leaves the old one unusable.
  const target = typeof remote_slug === "string" && remote_slug !== "" ? db.doc_slug(remote_slug) : (before?.remote_slug ?? d.slug);
  if (o.ask && before?.remote_slug !== target) {
    const there = await remote_doc(s, profile_id, target);
    if (there?.theirs) {
      throw ApiError.bad(`${site_name(c.site_url)} has “${target}” already, as ${there.v.owner}'s document: choose another slug`);
    }
    if (there) {
      const x = there.v;
      return {
        exists: {
          slug: target,
          title: typeof x.title === "string" ? x.title : target,
          latest_version: typeof x.latest_version === "number" ? x.latest_version : null,
          url: web_url(x.url) ? x.url : null,
          owner: typeof x.owner === "string" ? x.owner : null,
        },
      };
    }
  }
  const pages = db.doc_pages_full(s.db(), v.id).map((p) => ({ path: p.path, title: p.title, format: p.format, content: p.source }));
  const args: any = { slug: target, title: d.title, pages, mode: "replace" };
  if (v.message !== null) args.message = v.message;
  const out = await call_tool(s, profile_id, "publish_document", args);
  if (typeof out?.slug !== "string" || typeof out?.version !== "number" || !web_url(out?.url)) {
    throw new ApiError(502, `${site_name(c.site_url)} published it, but its answer isn't what was expected: ${JSON.stringify(out).slice(0, 300)}`);
  }
  // A first publish as a user with no documents before: the one published says who it is.
  await try_learn_login(s, profile_id, out.slug);
  const row = {
    site_url: c.site_url,
    remote_slug: out.slug,
    remote_version: out.version,
    local_version: v.number,
    url: out.url,
    version_url: web_url(out.version_url) ? out.version_url : out.url,
    login: db.docs_site_connection(s.db(), profile_id)?.login ?? null,
  };
  db.set_docs_site_published(s.db(), d.id, row);
  s.emit({ type: "docs", profile_id, slug: d.slug });
  return { published: db.docs_site_published(s.db(), d.id, c.site_url), warnings: Array.isArray(out.warnings) ? out.warnings : [] };
}
