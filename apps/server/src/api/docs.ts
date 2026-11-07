// Docs (HA-280, API 124): a profile's documents for the board to show, which its agents publish through the `docs` MCP
// server (mcp/docs_mcp.ts). They're this host's own, so a hub reaches them through `/h/{host}/…` like the rest.
//
// - `GET /profiles/{id}/docs`: its documents, most recently updated first.
// - `GET /profiles/{id}/docs/{slug}`: one, with its versions (newest first) and its latest version's pages.
// - `GET /profiles/{id}/docs/{slug}/versions/{n}` (`n` a number or `latest`): the version's pages, rendered (`html`,
//   `toc`), and its menu (`nav`). Relative links between pages point under `base_url`: the board's page for the
//   document (or for that version, for a number), unless `?base_url=` gives another, from `/` and ending in `/`.
//   `?path=` gives only that page (or that folder's index).
// - `DELETE /profiles/{id}/docs/{slug}`.
import * as db from "../db.ts";
import { ApiError, type Req } from "../http.ts";
import type { AppState } from "../state.ts";
import { err_str } from "../util.ts";
import * as runner from "../agent/runner.ts";
import * as docs_mcp from "../mcp/docs_mcp.ts";

function profile(s: AppState, r: Req): db.Profile {
  const p = db.get_profile(s.db(), r.params.id);
  if (!p) throw ApiError.not_found("profile");
  return p;
}

function doc(s: AppState, r: Req): db.Doc {
  const d = db.get_doc(s.db(), profile(s, r).id, r.params.slug);
  if (!d) throw ApiError.not_found("document");
  return d;
}

/** A row without its id: the board names documents by their slugs and versions by their numbers. */
function shown<T extends { id: string }>(row: T): Omit<T, "id"> {
  const { id, ...rest } = row;
  void id;
  return rest;
}

export async function list(s: AppState, r: Req) {
  return db.list_docs(s.db(), profile(s, r).id).map(shown);
}

/** The task that published a version, if it's still there: its title and key, for the board to link. */
function publisher(s: AppState, v: db.DocVersion): any {
  const t = v.task_id === null ? undefined : db.get_task(s.db(), v.task_id);
  if (!t) return null;
  let key: string | null = null;
  try {
    key = `${runner.task_key_prefix(s, t)}-${t.number}`;
  } catch {}
  return { id: t.id, title: t.title, key };
}

export async function get(s: AppState, r: Req) {
  const d = doc(s, r);
  const versions = db.doc_versions(s.db(), d.id);
  return {
    ...shown(d),
    versions: versions.map((v) => ({ ...shown(v), task: publisher(s, v) })),
    pages: versions.length ? db.doc_pages(s.db(), versions[0].id) : [],
  };
}

export async function version(s: AppState, r: Req) {
  const d = doc(s, r);
  const n = r.params.n;
  if (n !== "latest" && !/^[0-9]{1,15}$/.test(n)) throw ApiError.bad("the version is a number or latest");
  const number = n === "latest" ? null : Number(n);
  const v = db.doc_version(s.db(), d.id, number);
  if (!v) throw ApiError.not_found("version");
  const base = r.query.base_url ?? docs_mcp.doc_base(d.profile_id, d.slug, number);
  if (!base.startsWith("/") || !base.endsWith("/") || base.startsWith("//")) throw ApiError.bad("base_url is a path from / that ends in /");
  const lib = await docs_mcp.renderer();
  let pages = db.doc_pages_full(s.db(), v.id);
  const nav = lib.navTree(pages.map((p) => [p.path, p.title]));
  if (r.query.path !== undefined) {
    let path: string;
    try {
      path = lib.normalizePath(r.query.path);
    } catch (e) {
      throw ApiError.bad(typeof e === "string" ? e : err_str(e));
    }
    const page = pages.find((p) => p.path === path) ?? pages.find((p) => p.path === `${path}/index`);
    if (!page) throw ApiError.not_found("page");
    pages = [page];
  }
  return {
    slug: d.slug,
    title: d.title,
    number: v.number,
    latest_version: d.latest_version,
    message: v.message,
    created_at: v.created_at,
    task: publisher(s, v),
    base_url: base,
    nav,
    pages: pages.map((p) => {
      const out: any = { path: p.path, title: p.title, format: p.format, url_suffix: lib.urlSuffix(p.path) };
      try {
        const page = lib.render(p.source, p.format === "mdx" ? "mdx" : "md", { pagePath: p.path, baseUrl: base });
        Object.assign(out, { html: page.html, toc: page.toc, has_h1: page.hasH1, warnings: page.warnings, error: null });
      } catch (e) {
        // Checked when it was published, so only a renderer that changed since would get here.
        Object.assign(out, { html: null, toc: [], has_h1: false, warnings: [], error: typeof e === "string" ? e : err_str(e) });
      }
      return out;
    }),
  };
}

export async function remove(s: AppState, r: Req) {
  const p = profile(s, r);
  if (!db.delete_doc(s.db(), p.id, r.params.slug)) throw ApiError.not_found("document");
  s.emit({ type: "docs", profile_id: p.id, slug: r.params.slug, deleted: true });
  return {};
}
