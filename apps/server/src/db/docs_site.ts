// Hosted docs (HA-282): each profile's connection to a hosted docs site (dire-kiwi/docs), the OAuth clients this host
// registered with those sites, and which of its documents it published there (see integrations/docs_site.ts). The
// tokens are kept here alone: no API returns them, and nothing logs them.
import { one, run, type Conn } from "../db.ts";
import { now } from "../util.ts";

/** The tables (migration 104). */
export const DOCS_SITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS docs_site_clients (
  site_url TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS docs_site_connections (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  site_url TEXT NOT NULL,
  kind TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER,
  login TEXT,
  connected_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS docs_site_published (
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  site_url TEXT NOT NULL,
  remote_slug TEXT NOT NULL,
  remote_version INTEGER NOT NULL,
  local_version INTEGER NOT NULL,
  url TEXT NOT NULL,
  version_url TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, site_url)
);
`;

/** A profile's connection to a docs site. `kind` is `oauth` (the device flow's tokens) or `token` (a pasted one). */
export interface DocsSiteConnection {
  profile_id: string;
  site_url: string;
  kind: "oauth" | "token";
  access_token: string;
  refresh_token: string | null;
  /** When the access token expires, in milliseconds since the epoch (null: it doesn't, or isn't known to). */
  expires_at: number | null;
  /** The docs site's username, once it's known. */
  login: string | null;
  connected_at: string;
}

/** Where a document was published on a site: its slug there, the last version published (the site's and the local one). */
export interface DocsSitePublished {
  site_url: string;
  remote_slug: string;
  remote_version: number;
  local_version: number;
  url: string;
  version_url: string;
  published_at: string;
}

export function docs_site_client(c: Conn, site_url: string): string | null {
  return one<{ client_id: string }>(c, "SELECT client_id FROM docs_site_clients WHERE site_url=?1", site_url)?.client_id ?? null;
}

export function set_docs_site_client(c: Conn, site_url: string, client_id: string) {
  run(
    c,
    "INSERT INTO docs_site_clients (site_url, client_id, created_at) VALUES (?1,?2,?3) ON CONFLICT(site_url) DO UPDATE SET client_id=excluded.client_id, created_at=excluded.created_at",
    site_url,
    client_id,
    now(),
  );
}

export function docs_site_connection(c: Conn, profile_id: string): DocsSiteConnection | null {
  const r = one<any>(c, "SELECT * FROM docs_site_connections WHERE profile_id=?1", profile_id);
  return r ? { ...r, expires_at: r.expires_at === null ? null : Number(r.expires_at) } : null;
}

/** Connect the profile (replacing any connection it had). */
export function set_docs_site_connection(c: Conn, x: Omit<DocsSiteConnection, "connected_at">) {
  run(
    c,
    `INSERT INTO docs_site_connections (profile_id, site_url, kind, access_token, refresh_token, expires_at, login, connected_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(profile_id) DO UPDATE SET site_url=excluded.site_url, kind=excluded.kind,
     access_token=excluded.access_token, refresh_token=excluded.refresh_token, expires_at=excluded.expires_at, login=excluded.login,
     connected_at=excluded.connected_at`,
    x.profile_id,
    x.site_url,
    x.kind,
    x.access_token,
    x.refresh_token,
    x.expires_at,
    x.login,
    now(),
  );
}

/**
 * Save refreshed tokens, if the connection still has the refresh token they replace (the site rotates them: a
 * connection made again meanwhile keeps its own). Whether it did.
 */
export function refresh_docs_site_tokens(
  c: Conn,
  profile_id: string,
  used: string,
  access_token: string,
  refresh_token: string | null,
  expires_at: number | null,
) {
  return (
    run(
      c,
      "UPDATE docs_site_connections SET access_token=?1, refresh_token=?2, expires_at=?3 WHERE profile_id=?4 AND refresh_token=?5",
      access_token,
      refresh_token,
      expires_at,
      profile_id,
      used,
    ).changes > 0
  );
}

export function set_docs_site_login(c: Conn, profile_id: string, access_token: string, login: string) {
  run(c, "UPDATE docs_site_connections SET login=?1 WHERE profile_id=?2 AND access_token=?3", login, profile_id, access_token);
}

/** Forget the profile's connection (or, with `access_token`, only if it's still the one with that token). Whether it had one. */
export function delete_docs_site_connection(c: Conn, profile_id: string, access_token?: string): boolean {
  if (access_token === undefined) return run(c, "DELETE FROM docs_site_connections WHERE profile_id=?1", profile_id).changes > 0;
  return run(c, "DELETE FROM docs_site_connections WHERE profile_id=?1 AND access_token=?2", profile_id, access_token).changes > 0;
}

export function docs_site_published(c: Conn, doc_id: string, site_url: string): DocsSitePublished | null {
  const r = one<any>(
    c,
    "SELECT site_url, remote_slug, remote_version, local_version, url, version_url, published_at FROM docs_site_published WHERE doc_id=?1 AND site_url=?2",
    doc_id,
    site_url,
  );
  return r ? { ...r, remote_version: Number(r.remote_version), local_version: Number(r.local_version) } : null;
}

export function set_docs_site_published(c: Conn, doc_id: string, p: Omit<DocsSitePublished, "published_at">) {
  run(
    c,
    `INSERT INTO docs_site_published (doc_id, site_url, remote_slug, remote_version, local_version, url, version_url, published_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(doc_id, site_url) DO UPDATE SET remote_slug=excluded.remote_slug,
     remote_version=excluded.remote_version, local_version=excluded.local_version, url=excluded.url, version_url=excluded.version_url,
     published_at=excluded.published_at`,
    doc_id,
    p.site_url,
    p.remote_slug,
    p.remote_version,
    p.local_version,
    p.url,
    p.version_url,
    now(),
  );
}
