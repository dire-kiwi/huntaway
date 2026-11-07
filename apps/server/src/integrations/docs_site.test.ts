// Tests of hosted docs (HA-282): connecting a profile to a docs site with the device flow or a pasted token, renewing
// its sign-in, and publishing its documents there (integrations/docs_site.ts, through api/docs.ts), against a stub of
// the hosted site's OAuth and MCP endpoints (dire-kiwi/docs).
import { afterAll, test } from "vite-plus/test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as db from "../db.ts";
import { dispatch, makeReq, router } from "../api.ts";
import type { AppState } from "../state.ts";
import * as testing from "../testing.ts";
import * as docs_site from "./docs_site.ts";

docs_site.timing.slow_down_s = 0.05;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** The stub site's state: what it was asked, and what it answers. */
class Site {
  server!: Server;
  url = "";
  clients = new Map<string, string[]>();
  /** device_code → its state, user code and client. */
  devices = new Map<string, { state: "pending" | "approved" | "denied" | "expired"; user_code: string; client_id: string; polls: number; slow_down: number }>();
  /** Valid access tokens → user; refresh tokens → user (each works once). */
  access = new Map<string, string>();
  refresh = new Map<string, string>();
  /** Documents by slug: owner, who else can see it, and versions. */
  docs = new Map<string, { owner: string; shared?: string[]; title: string; versions: { message: string | null; pages: any[] }[] }>();
  log: string[] = [];
  expires_in = 3600;
  n = 0;
  /** Answer with `javascript:` URLs where the board would open or link them. */
  evil = false;

  async start() {
    this.server = createServer((req, res) => {
      void this.handle(req).then(([status, body, type]) => {
        res.writeHead(status, { "content-type": type ?? "application/json" });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  issue(user: string) {
    const [a, r] = [`at-${++this.n}`, `rt-${++this.n}`];
    this.access.set(a, user);
    this.refresh.set(r, user);
    return { access_token: a, token_type: "Bearer", expires_in: this.expires_in, refresh_token: r, scope: "docs" };
  }

  /** Approve (or deny) the latest device sign-in, as the user would on `/device`. */
  decide(state: "approved" | "denied" | "expired") {
    const last = [...this.devices.values()].at(-1)!;
    last.state = state;
  }

  async handle(req: IncomingMessage): Promise<[number, any, string?]> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const path = new URL(req.url!, "http://x").pathname;
    this.log.push(`${req.method} ${path}`);
    const form = Object.fromEntries(new URLSearchParams(raw));
    const err = (status: number, error: string, d = error) => [status, { error, error_description: d }] as [number, any];
    if (path === "/.well-known/oauth-authorization-server") {
      return [
        200,
        {
          issuer: this.url,
          token_endpoint: `${this.url}/oauth/token`,
          registration_endpoint: `${this.url}/oauth/register`,
          device_authorization_endpoint: `${this.url}/oauth/device_authorization`,
        },
      ];
    }
    if (path === "/oauth/register") {
      const b = JSON.parse(raw);
      const id = `client-${++this.n}`;
      this.clients.set(id, b.grant_types);
      this.log.push(`registered ${b.client_name} ${JSON.stringify(b.grant_types)} redirect_uris=${JSON.stringify(b.redirect_uris ?? null)}`);
      return [201, { client_id: id, grant_types: b.grant_types }];
    }
    if (path === "/oauth/device_authorization") {
      if (!this.clients.has(form.client_id)) return err(401, "invalid_client", "unknown client; register it first");
      const code = `dc-${++this.n}`;
      const user_code = `BCDF-${String(this.n).padStart(4, "G")}`;
      this.devices.set(code, { state: "pending", user_code, client_id: form.client_id, polls: 0, slow_down: 0 });
      return [
        200,
        {
          device_code: code,
          user_code,
          verification_uri: `${this.url}/device`,
          verification_uri_complete: this.evil ? "javascript:alert(1)" : `${this.url}/device?user_code=${user_code}`,
          expires_in: 600,
          interval: 0.02,
        },
      ];
    }
    if (path === "/oauth/token") {
      this.log.push(`token ${form.grant_type}`);
      if (form.grant_type === DEVICE_GRANT) {
        if (!form.client_id) return err(400, "invalid_request", "device_code and client_id are required");
        const d = this.devices.get(form.device_code);
        if (!d) return err(400, "invalid_grant", "unknown device code");
        if (d.client_id !== form.client_id) return err(400, "invalid_grant", "device code was issued to another client");
        d.polls++;
        if (d.slow_down > 0) {
          d.slow_down--;
          return err(400, "slow_down");
        }
        if (d.state === "pending") return err(400, "authorization_pending");
        if (d.state === "denied") return err(400, "access_denied", "the user denied access");
        if (d.state === "expired") return err(400, "expired_token");
        this.devices.delete(form.device_code);
        return [200, this.issue("ivan")];
      }
      if (form.grant_type === "refresh_token") {
        const user = this.refresh.get(form.refresh_token);
        if (!user) return err(400, "invalid_grant", "unknown or expired refresh token");
        this.refresh.delete(form.refresh_token);
        return [200, this.issue(user)];
      }
      return err(400, "unsupported_grant_type");
    }
    if (path === "/mcp") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const user = this.access.get(token);
      if (!user) return [401, { error: "invalid_token", error_description: "token is invalid or expired" }];
      const m = JSON.parse(raw);
      this.log.push(`tool ${m.params?.name} as ${user}`);
      const ok = (v: any) =>
        [200, { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(v) }], structuredContent: v } }] as [number, any];
      const fail = (text: string) => [200, { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }], isError: true } }] as [number, any];
      const a = m.params.arguments;
      switch (m.params.name) {
        case "list_documents":
          return ok({
            documents: [...this.docs].map(([slug, d]) => ({ slug, title: d.title, owner: d.owner, shared_with_you: d.owner !== user })),
          });
        case "get_document": {
          // As the site does: only a document the user can see, with its sharing for its owner only.
          const d = this.docs.get(a.slug);
          if (!d || (d.owner !== user && !d.shared?.includes(user))) return fail(`no document "${a.slug}"; call list_documents to see what exists`);
          const sharing = d.owner === user ? { shared_with: d.shared ?? [] } : null;
          return ok({ sharing, slug: a.slug, title: d.title, owner: d.owner, url: `${this.url}/d/${a.slug}/`, latest_version: d.versions.length });
        }
        case "publish_document": {
          let d = this.docs.get(a.slug);
          if (d && d.owner !== user) return fail(`the slug "${a.slug}" is taken by another user's document; choose a different slug, or omit it`);
          if (!d) this.docs.set(a.slug, (d = { owner: user, title: a.title, versions: [] }));
          d.versions.push({ message: a.message ?? null, pages: a.pages });
          const n = d.versions.length;
          const url = this.evil ? "javascript:alert(1)//" : `${this.url}/d/${a.slug}/`;
          return ok({
            slug: a.slug,
            version: n,
            url,
            version_url: `${url}-/v/${n}/`,
            pages: [],
            warnings: n === 1 ? [{ page: "index", warning: "a warning" }] : [],
          });
        }
      }
      return [200, { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "unknown tool" } }];
    }
    return [404, "not found", "text/plain"];
  }
}

const sites: Site[] = [];
afterAll(() => sites.forEach((s) => s.server.close()));
async function site() {
  const s = await new Site().start();
  sites.push(s);
  return s;
}

/** Status and body of a request to the API. */
async function call(s: AppState, method: string, path: string, body?: any): Promise<[number, any]> {
  if (!s.local_router) router(s);
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const a = await dispatch(s, makeReq(method, path, { authorization: "Bearer ", "content-type": "application/json" }, buf));
  const text = a.body.toString("utf8");
  try {
    return [a.status, JSON.parse(text)];
  } catch {
    return [a.status, text];
  }
}

async function until<T>(what: string, f: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A profile with a document of two versions. */
function setup(name = "p") {
  const s = testing.state();
  const events: any[] = [];
  const emit = s.emit.bind(s);
  s.emit = (ev: any) => {
    events.push(ev);
    emit(ev);
  };
  const profile = db.insert_profile(s.db(), name, [], null);
  for (const [i, text] of ["First draft", "Second draft"].entries()) {
    db.publish_doc(s.db(), {
      profile_id: profile.id,
      slug: "the-plan",
      title: "The plan",
      message: `v${i + 1}`,
      pages: [
        { path: "index", title: "The plan", format: "md", source: `# The plan\n\n${text}\n`, position: 0 },
        { path: "plan/phase-1", title: "Phase 1", format: "md", source: "# Phase 1\n", position: 1 },
      ],
      merge: false,
      delete: [],
      task_id: null,
      run_id: null,
    });
  }
  return { s, p: profile.id, events };
}

/** Connect `p` to `site` with the device flow. */
async function connect(s: AppState, p: string, site: Site) {
  const [st, started] = await call(s, "POST", `/api/profiles/${p}/hosted_docs/device`, { site_url: site.url });
  assert.equal(st, 200, JSON.stringify(started));
  site.decide("approved");
  return until("the connection", () => db.docs_site_connection(s.db(), p));
}

test("the device flow registers a client once, polls with slow_down, and connects without showing the tokens", async () => {
  const site_ = await site();
  const { s, p, events } = setup();
  const [st, started] = await call(s, "POST", `/api/profiles/${p}/hosted_docs/device`, { site_url: `${site_.url}/` });
  assert.equal(st, 200, JSON.stringify(started));
  assert.equal(started.connected, false);
  assert.equal(started.site_url, site_.url, "the URL loses its slash");
  assert.match(started.pending.user_code, /^BCDF-/);
  assert.equal(started.pending.verification_uri_complete, `${site_.url}/device?user_code=${started.pending.user_code}`);
  assert.ok(!JSON.stringify(started).includes("dc-"), "the device code stays on the host");
  // Registered as a device client with no redirect URIs.
  assert.ok(
    site_.log.some((l) => l === `registered Huntaway (${s.host_name}) ["${DEVICE_GRANT}","refresh_token"] redirect_uris=null`),
    site_.log.join("\n"),
  );

  // The site asks it to slow down twice before the user approves.
  const d = [...site_.devices.values()][0];
  d.slow_down = 2;
  await until("three polls", () => d.polls >= 3);
  let [, mid] = await call(s, "GET", `/api/profiles/${p}/hosted_docs`);
  assert.equal(mid.connected, false);
  assert.equal(mid.pending.error, null);
  site_.decide("approved");
  await until("the connection", () => db.docs_site_connection(s.db(), p));
  const [, done] = await call(s, "GET", `/api/profiles/${p}/hosted_docs`);
  assert.deepEqual(
    { ...done, connected_at: null },
    {
      default_site_url: "https://docs.nest.dire.nz",
      site_url: site_.url,
      connected: true,
      kind: "oauth",
      login: null,
      connected_at: null,
      pending: null,
    },
  );
  assert.ok(events.some((e) => e.type === "docs_site" && e.profile_id === p));
  // It asked who the user is (from their documents: they have none yet).
  await until("list_documents", () => site_.log.includes("tool list_documents as ivan"));

  // A second sign-in (to connect again) uses the same client.
  await call(s, "POST", `/api/profiles/${p}/hosted_docs/device`, { site_url: site_.url });
  assert.equal(site_.log.filter((l) => l.startsWith("registered")).length, 1);
  // Stopping it leaves the connection as it was.
  const [, stopped] = await call(s, "DELETE", `/api/profiles/${p}/hosted_docs/device`);
  assert.equal(stopped.pending, null);
  assert.equal(stopped.connected, true);
});

test("a denied or expired sign-in says so, and a forgotten client registers again", async () => {
  const site_ = await site();
  const { s, p } = setup();
  await call(s, "POST", `/api/profiles/${p}/hosted_docs/device`, { site_url: site_.url });
  site_.decide("denied");
  await until("the denial", () => docs_site.status(s, p).pending?.error);
  assert.match(docs_site.status(s, p).pending!.error!, /denied/);
  assert.equal(docs_site.status(s, p).connected, false);

  // The site lost its clients (its database was reset): the next sign-in registers again.
  site_.clients.clear();
  const [st, again] = await call(s, "POST", `/api/profiles/${p}/hosted_docs/device`, { site_url: site_.url });
  assert.equal(st, 200, JSON.stringify(again));
  assert.equal(again.pending.error, null);
  assert.equal(site_.log.filter((l) => l.startsWith("registered")).length, 2);
  site_.decide("expired");
  await until("the expiry", () => docs_site.status(s, p).pending?.error);
  assert.match(docs_site.status(s, p).pending!.error!, /expired/);
});

test("publish, then publish again: a new remote version of the same document, and the state the board shows", async () => {
  const site_ = await site();
  const { s, p, events } = setup();
  await connect(s, p, site_);

  // Not published yet.
  let [, list] = await call(s, "GET", `/api/profiles/${p}/docs`);
  assert.equal(list[0].published, null);

  // The first publish of version 1, under a slug of its own.
  let [st, out] = await call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, { version: 1, slug: "Our Plan" });
  assert.equal(st, 200, JSON.stringify(out));
  assert.deepEqual(out.warnings, [{ page: "index", warning: "a warning" }]);
  assert.equal(out.published.remote_slug, "our-plan");
  assert.equal(out.published.remote_version, 1);
  assert.equal(out.published.local_version, 1);
  assert.equal(out.published.url, `${site_.url}/d/our-plan/`);
  const sent = site_.docs.get("our-plan")!;
  assert.equal(sent.title, "The plan");
  assert.deepEqual(sent.versions[0], {
    message: "v1",
    pages: [
      { path: "index", title: "The plan", format: "md", content: "# The plan\n\nFirst draft\n" },
      { path: "plan/phase-1", title: "Phase 1", format: "md", content: "# Phase 1\n" },
    ],
  });
  assert.ok(events.some((e) => e.type === "docs" && e.slug === "the-plan"));
  // Who's connected, from the document published.
  await until("the login", () => db.docs_site_connection(s.db(), p)?.login === "ivan");

  // The document shows it's changed since: v2 is local only.
  [, list] = await call(s, "GET", `/api/profiles/${p}/docs`);
  assert.equal(list[0].latest_version, 2);
  assert.equal(list[0].published.local_version, 1);
  const [, detail] = await call(s, "GET", `/api/profiles/${p}/docs/the-plan`);
  assert.equal(detail.published.remote_slug, "our-plan");

  // Publishing again (the latest) adds a version to the same remote document, without asking.
  [st, out] = await call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, { ask: true });
  assert.equal(st, 200, JSON.stringify(out));
  assert.deepEqual([out.published.remote_slug, out.published.remote_version, out.published.local_version], ["our-plan", 2, 2]);
  assert.equal(out.published.login, "ivan");
  assert.equal(sent.versions.length, 2);
  assert.equal(sent.versions[1].message, "v2");
  assert.equal(site_.docs.size, 1);

  // Publishes of one document at once go one after the other, to the same remote document.
  const both = await Promise.all([
    call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, {}),
    call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, {}),
  ]);
  assert.deepEqual(
    both.map(([st, o]) => [st, o.published?.remote_version]),
    [
      [200, 3],
      [200, 4],
    ],
  );
  assert.equal(db.docs_site_published(s.db(), db.get_doc(s.db(), p, "the-plan")!.id, site_.url)!.remote_version, 4);

  // A document deleted locally takes its mapping with it.
  await call(s, "DELETE", `/api/profiles/${p}/docs/the-plan`);
  assert.equal(Number(db.value(s.db(), "SELECT COUNT(*) FROM docs_site_published")), 0);
});

test("the site's errors come back as they are: a slug taken, a version or document that isn't there, not connected", async () => {
  const site_ = await site();
  const { s, p } = setup();
  let [st, out] = await call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, {});
  assert.equal(st, 409);
  assert.match(out.error, /Connect this profile to docs\.nest\.dire\.nz first/);
  await connect(s, p, site_);
  site_.docs.set("the-plan", { owner: "someone-else", title: "Theirs", versions: [] });
  [st, out] = await call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, {});
  assert.equal(st, 400);
  assert.equal(out.error, `${new URL(site_.url).host}: the slug "the-plan" is taken by another user's document; choose a different slug, or omit it`);
  assert.equal(db.docs_site_published(s.db(), db.get_doc(s.db(), p, "the-plan")!.id, site_.url), null, "nothing is remembered");
  [st] = await call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, { version: 9 });
  assert.equal(st, 404);
  [st] = await call(s, "POST", `/api/profiles/${p}/docs/nothing/publish`, {});
  assert.equal(st, 404);
  [st] = await call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, { version: "2" });
  assert.equal(st, 400);
  // Another slug works.
  [st, out] = await call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, { slug: "my-plan" });
  assert.equal(st, 200, JSON.stringify(out));
});

test("a first publish asks before adding to the user's document at the slug, and says whose another user's is", async () => {
  // HA-286: the same slug published from another profile or host, or by an agent straight to the site.
  const site_ = await site();
  const { s, p } = setup();
  await connect(s, p, site_);
  site_.docs.set("the-plan", { owner: "ivan", title: "Published elsewhere", versions: [{ message: null, pages: [] }] });
  let [st, out] = await call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, { ask: true });
  assert.equal(st, 200, JSON.stringify(out));
  assert.deepEqual(out, {
    exists: { slug: "the-plan", title: "Published elsewhere", latest_version: 1, url: `${site_.url}/d/the-plan/`, owner: "ivan" },
  });
  const doc_id = db.get_doc(s.db(), p, "the-plan")!.id;
  assert.equal(site_.docs.get("the-plan")!.versions.length, 1, "nothing was published");
  assert.equal(db.docs_site_published(s.db(), doc_id, site_.url), null);
  // Confirmed: it's added to.
  [st, out] = await call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, {});
  assert.equal(st, 200, JSON.stringify(out));
  assert.deepEqual([out.published.remote_slug, out.published.remote_version], ["the-plan", 2]);

  // Another user's document that the user can see: theirs, so another slug it is.
  site_.docs.set("shared", { owner: "alice", shared: ["ivan"], title: "Alice's", versions: [{ message: null, pages: [] }] });
  [st, out] = await call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, { slug: "shared", ask: true });
  assert.equal(st, 400);
  assert.equal(out.error, `${new URL(site_.url).host} has “shared” already, as alice's document: choose another slug`);
  // A slug with nothing there publishes straight away, and re-targets the document.
  [st, out] = await call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, { slug: "Fresh Plan", ask: true });
  assert.equal(st, 200, JSON.stringify(out));
  assert.deepEqual([out.published.remote_slug, out.published.remote_version], ["fresh-plan", 1]);
  assert.equal(db.docs_site_published(s.db(), doc_id, site_.url)!.remote_slug, "fresh-plan");
});

test("a document published as another account, or to a remote one taken since, publishes again under a new slug", async () => {
  // HA-286: these used to fail with "taken by another user's document", and no other slug was allowed.
  const site_ = await site();
  const { s, p } = setup();
  await connect(s, p, site_);
  let [st, out] = await call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, {});
  assert.equal(st, 200, JSON.stringify(out));
  const doc_id = db.get_doc(s.db(), p, "the-plan")!.id;
  assert.equal(db.docs_site_published(s.db(), doc_id, site_.url)!.login, "ivan");

  // Connected again, as bob (who has a document there, so the site says who he is): it isn't published as bob.
  site_.access.set("bob-token", "bob");
  site_.docs.set("bobs-notes", { owner: "bob", title: "Notes", versions: [{ message: null, pages: [] }] });
  [st, out] = await call(s, "POST", `/api/profiles/${p}/hosted_docs/token`, { site_url: site_.url, token: "bob-token" });
  assert.equal(st, 200, JSON.stringify(out));
  assert.equal(out.login, "bob");
  let [, list] = await call(s, "GET", `/api/profiles/${p}/docs`);
  assert.equal(list[0].published, null);
  let [, detail] = await call(s, "GET", `/api/profiles/${p}/docs/the-plan`);
  assert.equal(detail.published, null);
  // Its slug is ivan's there (and bob can't see it): the site says so, and another slug works.
  [st, out] = await call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, { ask: true });
  assert.equal(st, 400);
  assert.match(out.error, /the slug "the-plan" is taken by another user's document/);
  [st, out] = await call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, { slug: "bobs-plan", ask: true });
  assert.equal(st, 200, JSON.stringify(out));
  assert.deepEqual([out.published.remote_slug, out.published.remote_version, out.published.login], ["bobs-plan", 1, "bob"]);
  [, list] = await call(s, "GET", `/api/profiles/${p}/docs`);
  assert.equal(list[0].published.remote_slug, "bobs-plan");

  // The remote document was deleted, and someone else took its slug: publishing to it fails, and a new slug works.
  site_.docs.set("bobs-plan", { owner: "mallory", title: "Mine now", versions: [] });
  [st, out] = await call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, {});
  assert.equal(st, 400);
  assert.match(out.error, /taken by another user's document/);
  [st, out] = await call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, { slug: "bobs-plan-2", ask: true });
  assert.equal(st, 200, JSON.stringify(out));
  [, detail] = await call(s, "GET", `/api/profiles/${p}/docs/the-plan`);
  assert.deepEqual([detail.published.remote_slug, detail.published.remote_version], ["bobs-plan-2", 1]);
});

test("an expired access token is renewed once for calls at once, the rotated refresh token is kept, and a revoked one disconnects", async () => {
  const site_ = await site();
  const { s, p, events } = setup();
  const before = await connect(s, p, site_);
  // The access token has expired (by the host's clock).
  db.run(s.db(), "UPDATE docs_site_connections SET expires_at=?1", Date.now() - 1000);
  const both = await Promise.all([call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, {}), docs_site.call_tool(s, p, "list_documents", {})]);
  assert.equal(both[0][0], 200, JSON.stringify(both[0][1]));
  const after = db.docs_site_connection(s.db(), p)!;
  assert.notEqual(after.access_token, before.access_token);
  assert.notEqual(after.refresh_token, before.refresh_token);
  assert.ok(after.expires_at! > Date.now() + 3000_000);
  assert.equal(site_.log.filter((l) => l === "token refresh_token").length, 1, "one refresh for both");

  // The site forgets the access token (it expired early, say): renewed on the 401, and the call goes through.
  site_.access.clear();
  const v = await docs_site.call_tool(s, p, "list_documents", {});
  assert.ok(Array.isArray(v.documents));

  // Revoked on the site: the next call says to connect again, and the profile is disconnected.
  site_.access.clear();
  site_.refresh.clear();
  events.length = 0;
  const [st, out] = await call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, {});
  assert.equal(st, 409);
  assert.match(out.error, /expired or was revoked .*connect again/);
  assert.equal(db.docs_site_connection(s.db(), p), null);
  assert.ok(events.some((e) => e.type === "docs_site"));
  // Where it was published is still known, and still shown: the profile is still on that site (HA-286).
  const [, list] = await call(s, "GET", `/api/profiles/${p}/docs`);
  assert.equal(list[0].published?.remote_slug, "the-plan");
  assert.equal(docs_site.status(s, p).site_url, site_.url);
  assert.equal(db.docs_site_published(s.db(), db.get_doc(s.db(), p, "the-plan")!.id, site_.url)!.remote_version, 1);
});

test("a pasted access token connects once the site takes it, and one it no longer takes disconnects", async () => {
  const site_ = await site();
  const { s, p } = setup();
  let [st, out] = await call(s, "POST", `/api/profiles/${p}/hosted_docs/token`, { site_url: site_.url, token: "nope" });
  assert.equal(st, 400);
  assert.match(out.error, /doesn't take that token/);
  [st] = await call(s, "POST", `/api/profiles/${p}/hosted_docs/token`, { site_url: site_.url, token: "  " });
  assert.equal(st, 400);
  [st] = await call(s, "POST", `/api/profiles/${p}/hosted_docs/token`, { site_url: "ftp://x", token: "pat" });
  assert.equal(st, 400);

  site_.access.set("pat-1", "ivan");
  site_.docs.set("shared", { owner: "someone-else", title: "Shared", versions: [] });
  site_.docs.set("mine", { owner: "ivan", title: "Mine", versions: [] });
  [st, out] = await call(s, "POST", `/api/profiles/${p}/hosted_docs/token`, { site_url: site_.url, token: " pat-1 " });
  assert.equal(st, 200, JSON.stringify(out));
  assert.equal(out.kind, "token");
  assert.equal(out.login, "ivan", "its own document's owner, not the shared one's");
  assert.ok(!JSON.stringify(out).includes("pat-1"));
  [st, out] = await call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, {});
  assert.equal(st, 200, JSON.stringify(out));

  site_.access.delete("pat-1");
  [st, out] = await call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, {});
  assert.equal(st, 409);
  assert.match(out.error, /no longer accepts .*connect again/);
  assert.equal(db.docs_site_connection(s.db(), p), null);
});

test("disconnecting forgets the tokens, and a site that isn't a docs site or can't be reached says so", async () => {
  const site_ = await site();
  const { s, p } = setup();
  await connect(s, p, site_);
  const [st, out] = await call(s, "DELETE", `/api/profiles/${p}/hosted_docs`);
  assert.equal(st, 200);
  assert.equal(out.connected, false);
  // Still on the site it was connected to (HA-286), not the default.
  assert.equal(out.site_url, site_.url);
  assert.equal(out.default_site_url, "https://docs.nest.dire.nz");
  assert.equal(docs_site.status(s, p).site_url, site_.url);
  assert.equal(Number(db.value(s.db(), "SELECT COUNT(*) FROM docs_site_connections")), 0);

  let [st2, bad] = await call(s, "POST", `/api/profiles/${p}/hosted_docs/device`, { site_url: `${site_.url}/elsewhere` });
  assert.equal(st2, 502);
  assert.match(bad.error, /doesn't look like a docs site/);
  [st2, bad] = await call(s, "POST", `/api/profiles/${p}/hosted_docs/device`, { site_url: "http://127.0.0.1:9" });
  assert.equal(st2, 502);
  assert.match(bad.error, /couldn't reach 127\.0\.0\.1:9/);
  // Another profile's connection is its own.
  const other = db.insert_profile(s.db(), "q", [], null);
  await connect(s, p, site_);
  assert.equal(docs_site.status(s, other.id).connected, false);
});

test("site URLs", () => {
  assert.equal(docs_site.site_url(undefined), "https://docs.nest.dire.nz");
  assert.equal(docs_site.site_url("docs.example.com/"), "https://docs.example.com");
  assert.equal(docs_site.site_url("http://localhost:3000//"), "http://localhost:3000");
  for (const bad of ["javascript:alert(1)", "https://u:p@x", "https://x/?a=1", 5]) assert.throws(() => docs_site.site_url(bad), String(bad));
});

test("URLs from the site that the board opens or links are web pages' only", async () => {
  const site_ = await site();
  const { s, p } = setup();
  await connect(s, p, site_);
  site_.evil = true;
  const [, started] = await call(s, "POST", `/api/profiles/${p}/hosted_docs/device`, { site_url: site_.url });
  assert.equal(started.pending.verification_uri_complete, null);
  assert.equal(started.pending.verification_uri, `${site_.url}/device`);
  const [st, out] = await call(s, "POST", `/api/profiles/${p}/docs/the-plan/publish`, {});
  assert.equal(st, 502);
  assert.match(out.error, /isn't what was expected/);
  assert.equal(db.docs_site_published(s.db(), db.get_doc(s.db(), p, "the-plan")!.id, site_.url), null);
});
