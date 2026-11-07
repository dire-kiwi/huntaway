// Docs (HA-280): each profile's documents, which its agents publish through the `docs` MCP server (mcp/docs_mcp.ts) as
// they would to the hosted docs app (dire-kiwi/docs), and which the board shows (api/docs.ts). The model is the hosted
// app's: a document has immutable versions, each with its pages (Markdown or MDX), and every publish makes a new one.
// Slugs are unique per profile. The pages are checked before they get here (docs-render's validatePages).
import { all, one, run, tx, value, type Conn } from "../db.ts";
import { new_id, now } from "../util.ts";

/** The tables (migration 103). */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (profile_id, slug)
);
CREATE TABLE IF NOT EXISTS doc_versions (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  message TEXT,
  task_id TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (doc_id, number)
);
CREATE TABLE IF NOT EXISTS doc_pages (
  version_id TEXT NOT NULL REFERENCES doc_versions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  format TEXT NOT NULL,
  source TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (version_id, path)
);
`;

export interface Doc {
  id: string;
  profile_id: string;
  slug: string;
  title: string;
  created_at: string;
  updated_at: string;
  latest_version: number;
  /** How many pages its latest version has. */
  page_count: number;
}

export interface DocVersion {
  id: string;
  number: number;
  message: string | null;
  /** The task and run that published it, if it was published by an agent's run. */
  task_id: string | null;
  run_id: string | null;
  created_at: string;
}

export interface DocPageSummary {
  path: string;
  title: string;
  format: string;
  position: number;
}

export interface DocPage extends DocPageSummary {
  source: string;
}

/** A page ready to store (one of validatePages' pages, with its source). */
export interface NewDocPage {
  path: string;
  title: string;
  format: string;
  source: string;
  position: number;
}

export interface Publish {
  profile_id: string;
  /** The document to add a version to, created if it doesn't exist; null makes a new one with a slug from the title. */
  slug: string | null;
  title: string | null;
  message: string | null;
  pages: NewDocPage[];
  /** Keep the previous version's pages that aren't in `pages` (and not in `delete`). */
  merge: boolean;
  /** Normalised paths of pages to drop (with `merge`). */
  delete: string[];
  task_id: string | null;
  run_id: string | null;
}

const DOC = `SELECT d.id, d.profile_id, d.slug, d.title, d.created_at, d.updated_at,
  (SELECT MAX(number) FROM doc_versions v WHERE v.doc_id = d.id) AS latest_version,
  (SELECT COUNT(*) FROM doc_pages p JOIN doc_versions v ON v.id = p.version_id
     WHERE v.doc_id = d.id AND v.number = (SELECT MAX(number) FROM doc_versions WHERE doc_id = d.id)) AS page_count
  FROM docs d`;

const doc_row = (r: any): Doc => ({ ...r, latest_version: Number(r.latest_version ?? 0), page_count: Number(r.page_count) });

/** A profile's documents, most recently updated first. */
export function list_docs(c: Conn, profile_id: string): Doc[] {
  return all(c, `${DOC} WHERE d.profile_id=?1 ORDER BY d.updated_at DESC, d.slug`, profile_id).map(doc_row);
}

export function get_doc(c: Conn, profile_id: string, slug: string): Doc | null {
  const r = one(c, `${DOC} WHERE d.profile_id=?1 AND d.slug=?2`, profile_id, slug);
  return r ? doc_row(r) : null;
}

/** A document's versions, newest first. */
export function doc_versions(c: Conn, doc_id: string): DocVersion[] {
  return all<DocVersion>(c, "SELECT id, number, message, task_id, run_id, created_at FROM doc_versions WHERE doc_id=?1 ORDER BY number DESC", doc_id);
}

/** Version `number` of a document, or its latest when `number` is null. */
export function doc_version(c: Conn, doc_id: string, number: number | null): DocVersion | null {
  const cols = "SELECT id, number, message, task_id, run_id, created_at FROM doc_versions";
  const r =
    number === null
      ? one<DocVersion>(c, `${cols} WHERE doc_id=?1 ORDER BY number DESC LIMIT 1`, doc_id)
      : one<DocVersion>(c, `${cols} WHERE doc_id=?1 AND number=?2`, doc_id, number);
  return r ?? null;
}

/** A version's pages, in menu order. */
export function doc_pages(c: Conn, version_id: string): DocPageSummary[] {
  return all<DocPageSummary>(c, "SELECT path, title, format, position FROM doc_pages WHERE version_id=?1 ORDER BY position, path", version_id);
}

/** A version's pages with their sources, in menu order. */
export function doc_pages_full(c: Conn, version_id: string): DocPage[] {
  return all<DocPage>(c, "SELECT path, title, format, position, source FROM doc_pages WHERE version_id=?1 ORDER BY position, path", version_id);
}

export function doc_page(c: Conn, version_id: string, path: string): DocPage | null {
  return one<DocPage>(c, "SELECT path, title, format, position, source FROM doc_pages WHERE version_id=?1 AND path=?2", version_id, path) ?? null;
}

/** The hosted app's slug for a title or a given slug (its `db::doc_slug`): lowercase ASCII letters and digits, with dashes between, at most about 60. */
export function doc_slug(title: string): string {
  let s = "";
  for (const ch of title.toLowerCase()) {
    if (/^[a-z0-9]$/.test(ch)) s += ch;
    else if (s !== "" && !s.endsWith("-")) s += "-";
    if (s.length >= 60) break;
  }
  s = s.replace(/^-+|-+$/g, "");
  return s === "" ? "doc" : s;
}

/** Whether the profile has a document with this slug (as `doc_slug` makes it). */
export function doc_exists(c: Conn, profile_id: string, slug: string): boolean {
  return value(c, "SELECT 1 FROM docs WHERE profile_id=?1 AND slug=?2", profile_id, doc_slug(slug)) !== undefined;
}

/** Make a new version (and the document, if it's new), as the hosted app's `db::publish` does. Returns its slug and number. */
export function publish_doc(c: Conn, p: Publish): { slug: string; number: number } {
  return tx(c, () => {
    const ts = now();
    const wanted = p.slug === null ? null : doc_slug(p.slug);
    const existing =
      wanted === null ? undefined : one<{ id: string; slug: string }>(c, "SELECT id, slug FROM docs WHERE profile_id=?1 AND slug=?2", p.profile_id, wanted);
    let doc_id: string;
    let slug: string;
    if (existing) {
      [doc_id, slug] = [existing.id, existing.slug];
      if (p.title !== null) run(c, "UPDATE docs SET title=?1 WHERE id=?2", p.title, doc_id);
    } else {
      const title = p.title ?? "Untitled";
      const base = wanted ?? doc_slug(title);
      slug = base;
      for (let n = 2; value(c, "SELECT 1 FROM docs WHERE profile_id=?1 AND slug=?2", p.profile_id, slug) !== undefined; n++) slug = `${base}-${n}`;
      doc_id = new_id();
      run(c, "INSERT INTO docs (id, profile_id, slug, title, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?5)", doc_id, p.profile_id, slug, title, ts);
    }
    const prev = one<{ id: string; number: number }>(c, "SELECT id, number FROM doc_versions WHERE doc_id=?1 ORDER BY number DESC LIMIT 1", doc_id);
    const number = prev ? Number(prev.number) + 1 : 1;
    const version_id = new_id();
    run(
      c,
      "INSERT INTO doc_versions (id, doc_id, number, message, task_id, run_id, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
      version_id,
      doc_id,
      number,
      p.message,
      p.task_id,
      p.run_id,
      ts,
    );
    const insert = "INSERT INTO doc_pages (version_id, path, title, format, source, position) VALUES (?1,?2,?3,?4,?5,?6)";
    for (const page of p.pages) run(c, insert, version_id, page.path, page.title, page.format, page.source, page.position);
    if (p.merge && prev) {
      // The previous version's other pages carry over.
      const given = new Set(p.pages.map((pg) => pg.path));
      for (const old of doc_pages_full(c, prev.id)) {
        if (given.has(old.path) || p.delete.includes(old.path)) continue;
        run(c, insert, version_id, old.path, old.title, old.format, old.source, old.position);
      }
    }
    if (Number(value(c, "SELECT COUNT(*) FROM doc_pages WHERE version_id=?1", version_id)) === 0) throw new Error("a version needs at least one page");
    run(c, "UPDATE docs SET updated_at=?1 WHERE id=?2", ts, doc_id);
    return { slug, number };
  });
}

/** Delete a profile's document with all its versions. Whether there was one. */
export function delete_doc(c: Conn, profile_id: string, slug: string): boolean {
  return run(c, "DELETE FROM docs WHERE profile_id=?1 AND slug=?2", profile_id, slug).changes > 0;
}
