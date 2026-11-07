/**
 * The `docs` MCP server (HA-280): agents publish documents (reports, plans, write-ups) to their profile's own document
 * store on this host (db/docs.ts), exactly as they would to the hosted docs app (dire-kiwi/docs): the tools, their
 * schemas, checks, errors and warnings are the hosted server's, from its renderer as WebAssembly (`@dire-kiwi/docs-render`).
 * Its `get_feedback` and `share_document` are left out: local documents have no forms' answers or sharing yet.
 *
 * Every run gets it, served over HTTP beside the board's own servers (see mcp/http.ts). A document belongs to the
 * profile of the run's task, and its URL is the board's page for it (`doc_base`).
 */
import * as db from "../db.ts";
import type { Conn } from "../db.ts";
import type { Shared } from "../state.ts";
import { VERSION } from "../hosts/proto.ts";
import { err_str } from "../util.ts";

export const SERVER_NAME = "docs";

/** The hosted server's tools this one leaves out. */
const LEFT_OUT = ["get_feedback", "share_document"];

/** The protocol versions it speaks, newest first (the hosted server's). */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** Sent with `initialize`; Claude Code adds it to the agent's system prompt. */
const INSTRUCTIONS =
  "Docs keeps Markdown documents for the user to read on this Huntaway board: reports, plans, research, write-ups. " +
  "Publish with `publish_document` (one or more pages; nested paths like `plan/phase-1` make a nested menu). Every " +
  'publish creates a new version, so you can revise freely; `mode: "merge"` keeps the other pages of the previous ' +
  'version. Use format "mdx" for components such as callouts (call `list_components` for the list). Form fields ' +
  "(`<Approval />`, inputs and the like) show read-only here and collect no answers, so ask the user in the thread " +
  "for a decision or input instead. Documents belong to your profile on this board. Always give the reader the URL " +
  "returned by `publish_document`.";

type Renderer = typeof import("@dire-kiwi/docs-render");
let loaded: Promise<Renderer> | null = null;

/** The renderer, loaded (WebAssembly, about 1.7 MB) the first time something needs it. */
export function renderer(): Promise<Renderer> {
  loaded ??= import("@dire-kiwi/docs-render");
  return loaded;
}

/** Who a docs call is for: the profile its documents belong to, and the task and run that publish (if known). */
export interface DocsRun {
  profile_id: string;
  task_id: string | null;
  run_id: string | null;
}

/** The board's address, which documents' URLs start with: the host's `public_url` if it's set, else its own. */
export function board_url(s: Shared): string {
  const set = db.get_setting(s.db(), "public_url")?.trim();
  return (set ? set : s.internal_url).replace(/\/+$/, "");
}

/** Where the board shows a document (its latest version, or version `version`), ending in `/`: page URLs follow it. */
export function doc_base(profile_id: string, slug: string, version: number | null): string {
  const d = `/docs/${encodeURIComponent(profile_id)}/d/${encodeURIComponent(slug)}/`;
  return version === null ? d : `${d}-/v/${version}/`;
}

/** The tools it offers: the hosted server's (`toolDefinitions`), but those it leaves out. */
export async function tools(): Promise<any[]> {
  return (await renderer()).toolDefinitions().filter((t) => !LEFT_OUT.includes(t.name));
}

/** A tool's failure, reported to the agent rather than as a protocol error. */
class ToolError extends Error {}

/** serde's description of a JSON value's type, for "invalid type" errors. */
function json_kind(v: any): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "a sequence";
  if (typeof v === "number") return Number.isInteger(v) ? `integer \`${v}\`` : `floating point \`${v}\``;
  if (typeof v === "string") return `string ${JSON.stringify(v)}`;
  if (typeof v === "boolean") return `boolean \`${v}\``;
  return "a map";
}

/** The tool's arguments, read as the hosted server's serde structs do (`invalid arguments: …`). */
class Args {
  a: Record<string, any>;
  constructor(v: any) {
    if (v === null || v === undefined) v = {};
    if (typeof v !== "object" || Array.isArray(v)) throw new ToolError(`invalid arguments: invalid type: ${json_kind(v)}, expected a map`);
    this.a = v;
  }
  private bad(v: any, expected: string): never {
    throw new ToolError(`invalid arguments: invalid type: ${json_kind(v)}, expected ${expected}`);
  }
  str(k: string): string {
    const v = this.a[k];
    if (v === undefined) throw new ToolError(`invalid arguments: missing field \`${k}\``);
    return typeof v === "string" ? v : this.bad(v, "a string");
  }
  opt_str(k: string): string | null {
    const v = this.a[k];
    if (v === undefined || v === null) return null;
    return typeof v === "string" ? v : this.bad(v, "a string");
  }
  opt_int(k: string): number | null {
    const v = this.a[k];
    if (v === undefined || v === null) return null;
    return typeof v === "number" && Number.isInteger(v) ? v : this.bad(v, "i64");
  }
  str_list(k: string): string[] {
    const v = this.a[k];
    if (v === undefined) return [];
    if (!Array.isArray(v)) return this.bad(v, "a sequence");
    return v.map((x) => (typeof x === "string" ? x : this.bad(x, "a string")));
  }
}

/** The tools' answers, given the renderer and the run (see `call`). */
class Server {
  s: Shared;
  r: DocsRun;
  lib: Renderer;
  board: string;
  constructor(s: Shared, r: DocsRun, lib: Renderer, board: string) {
    [this.s, this.r, this.lib, this.board] = [s, r, lib, board];
  }

  private get c(): Conn {
    return this.s.db();
  }

  url(slug: string, version: number | null, path: string): string {
    return `${this.board}${doc_base(this.r.profile_id, slug, version)}${this.lib.urlSuffix(path)}`;
  }

  doc(slug: string): db.Doc {
    const d = db.get_doc(this.c, this.r.profile_id, slug);
    if (!d) throw new ToolError(`no document ${JSON.stringify(slug)}; call list_documents to see what exists`);
    return d;
  }

  version(d: db.Doc, number: number | null): db.DocVersion {
    const v = db.doc_version(this.c, d.id, number);
    if (!v) throw new ToolError(`document ${JSON.stringify(d.slug)} has no version ${number ?? 0}`);
    return v;
  }

  list_documents(): any {
    return {
      documents: db.list_docs(this.c, this.r.profile_id).map((d) => ({
        slug: d.slug,
        title: d.title,
        url: this.url(d.slug, null, "index"),
        latest_version: d.latest_version,
        pages: d.page_count,
        updated_at: d.updated_at,
      })),
    };
  }

  get_document(a: Args): any {
    const [slug, number] = [a.str("slug"), a.opt_int("version")];
    const d = this.doc(slug);
    const v = this.version(d, number);
    return {
      slug: d.slug,
      title: d.title,
      url: this.url(d.slug, null, "index"),
      version: version_json(v),
      latest_version: d.latest_version,
      pages: db.doc_pages(this.c, v.id).map((p) => ({ path: p.path, title: p.title, format: p.format, url: this.url(d.slug, number, p.path) })),
      versions: db.doc_versions(this.c, d.id).slice(0, 50).map(version_json),
    };
  }

  read_page(a: Args): any {
    const [slug, raw, number] = [a.str("slug"), a.str("path"), a.opt_int("version")];
    const d = this.doc(slug);
    const v = this.version(d, number);
    const path = this.lib.normalizePath(raw);
    const page = db.doc_page(this.c, v.id, path) ?? db.doc_page(this.c, v.id, `${path}/index`);
    if (!page) throw new ToolError(`version ${v.number} has no page ${JSON.stringify(path)}`);
    return {
      path: page.path,
      title: page.title,
      format: page.format,
      version: v.number,
      url: this.url(d.slug, v.number, page.path),
      content: page.source,
    };
  }

  publish_document(a: Args): any {
    const slug = a.opt_str("slug");
    const title = a.opt_str("title");
    const message = a.opt_str("message");
    const mode = a.opt_str("mode") ?? "replace";
    const delete_paths = a.str_list("delete_paths");
    const given = a.a.pages === undefined ? [] : a.a.pages;
    if (!Array.isArray(given)) throw new ToolError(`invalid arguments: invalid type: ${json_kind(given)}, expected a sequence`);
    if (mode !== "replace" && mode !== "merge") throw new ToolError(`mode must be "replace" or "merge", not ${JSON.stringify(mode)}`);
    if (given.length === 0 && delete_paths.length === 0) throw new ToolError("pass at least one page");
    let checked: ReturnType<Renderer["validatePages"]>;
    try {
      checked = this.lib.validatePages(given);
    } catch (e) {
      // The renderer reads the pages with serde_json::from_str ("invalid pages: … at line 1 column 9"); the hosted
      // server reads them with the rest of the arguments ("invalid arguments: …", with no position).
      if (typeof e === "string" && e.startsWith("invalid pages: ")) throw new ToolError(`invalid arguments: ${e.slice(15).replace(/ at line \d+ column \d+$/, "")}`);
      throw e;
    }
    const { pages: valid, warnings } = checked;
    // validatePages gives the pages in the order they came, without their sources.
    const pages: db.NewDocPage[] = valid.map((p, i) => ({ path: p.path, title: p.title, format: p.format, position: p.position, source: given[i].content }));
    const exists = slug !== null && db.doc_exists(this.c, this.r.profile_id, slug);
    // A new document's title is its index page's (or its first page's), unless it's given.
    const new_title = exists ? null : (pages.find((p) => p.path === "index") ?? pages[0])?.title;
    const deleted = delete_paths.flatMap((p) => {
      try {
        return [this.lib.normalizePath(p)];
      } catch {
        return [];
      }
    });
    const out = db.publish_doc(this.c, {
      profile_id: this.r.profile_id,
      slug,
      title: title ?? new_title ?? null,
      message,
      pages,
      merge: mode === "merge",
      delete: deleted,
      task_id: this.r.task_id,
      run_id: this.r.run_id,
    });
    this.s.emit({ type: "docs", profile_id: this.r.profile_id, slug: out.slug });
    const v = this.version(this.doc(out.slug), out.number);
    return {
      slug: out.slug,
      version: out.number,
      url: this.url(out.slug, null, "index"),
      version_url: this.url(out.slug, out.number, "index"),
      pages: db.doc_pages(this.c, v.id).map((p) => ({ path: p.path, title: p.title, url: this.url(out.slug, null, p.path) })),
      warnings,
    };
  }
}

/** A version as the tools show it. */
function version_json(v: db.DocVersion): any {
  return { number: v.number, message: v.message, task_id: v.task_id, created_at: v.created_at };
}

/**
 * Tool `name`'s answer to the agent (an MCP `tools/call` result), or null for a tool it doesn't have. Failures, the
 * renderer's checks' included, are the hosted server's messages, as tool errors.
 */
export async function call(s: Shared, r: DocsRun, name: string, args: any): Promise<any> {
  if (!["list_documents", "get_document", "read_page", "publish_document", "list_components"].includes(name)) return null;
  let out: any;
  try {
    const lib = await renderer();
    const server = new Server(s, r, lib, board_url(s));
    if (name === "list_components") out = lib.componentsReference();
    else if (name === "list_documents") out = server.list_documents();
    else out = (server as any)[name](new Args(args));
  } catch (e) {
    // The renderer throws its messages as strings.
    return { content: [{ type: "text", text: typeof e === "string" ? e : err_str(e) }], isError: true };
  }
  if (typeof out === "string") return { content: [{ type: "text", text: out }] };
  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
}

/** Answer a JSON-RPC message from run `r`'s agent; null for a notification, which gets none. */
export async function handle(s: Shared, msg: any, r: DocsRun): Promise<any> {
  if (msg === null || typeof msg !== "object" || !Object.hasOwn(msg, "id")) return null;
  const id = msg.id;
  const method = typeof msg.method === "string" ? msg.method : "";
  const params = msg.params ?? {};
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  let result: any;
  switch (method) {
    case "":
      return error(-32600, "invalid request");
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      result = {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "huntaway-docs", title: "Docs", version: VERSION },
        instructions: INSTRUCTIONS,
      };
      break;
    }
    case "ping":
      result = {};
      break;
    case "tools/list":
      result = { tools: await tools() };
      break;
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      result = await call(s, r, name, params.arguments ?? {});
      if (result === null) return error(-32602, `unknown tool ${JSON.stringify(name)}`);
      break;
    }
    case "resources/list":
      result = { resources: [] };
      break;
    case "prompts/list":
      result = { prompts: [] };
      break;
    default:
      return error(-32601, `method not found: ${method}`);
  }
  return { jsonrpc: "2.0", id, result };
}

/** Run `run_id`'s docs caller: its task's profile. Null for a run that's gone. */
export function run_caller(s: Shared, run_id: string): DocsRun | null {
  const c = s.db();
  const run = db.get_run(c, run_id);
  const task = run ? db.get_task(c, run.task_id) : undefined;
  return task ? { profile_id: task.profile_id, task_id: task.id, run_id } : null;
}
