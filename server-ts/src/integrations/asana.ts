// Port of server/src/integrations/asana.rs.
/**
 * Asana, for linking a task to the Asana task it's for (API 57). A profile connects with a
 * personal access token (see db::Profile::asana_token), and the link dialog finds tasks with
 * Asana's typeahead search across the user's workspaces, or by a pasted task URL. The link
 * itself is stored on the task as an external link (see db::ExternalLink).
 */

/** A fake Asana for this process's tests (see asana/tests.ts's `fake`). */
let TEST_URL: string | null = null;

/** Points this process's calls at a fake Asana (tests only). */
export function set_test_url(url: string | null) {
  TEST_URL = url;
}

/** Asana's API. `IA_ASANA_URL` points it elsewhere, for a test server. */
function base_url(): string {
  if (TEST_URL) return TEST_URL;
  return process.env.IA_ASANA_URL ?? "https://app.asana.com/api/1.0";
}

/** How many tasks a search finds at most in each workspace (Asana's typeahead takes up to 100). */
const SEARCH_RESULTS = 25;

const TASK_FIELDS = "name,completed,permalink_url,notes,assignee.name,projects.name,workspace.name";

/** The Asana user a token belongs to. */
export interface User {
  name: string;
  email: string | null;
  /** Workspace gids. */
  workspaces: string[];
}

/** How the profile shows who it's connected as. */
export function label(u: User): string {
  return u.email && u.email !== u.name ? `${u.name} (${u.email})` : u.name;
}

/** An Asana task, as the link dialog lists it. */
export interface AsanaTask {
  gid: string;
  name: string;
  url: string;
  completed: boolean;
  /** Its description, as plain text. */
  notes: string;
  assignee: string | null;
  projects: string[];
  workspace: string | null;
}

const str = (v: any): string | null => (typeof v === "string" ? v : null);

export function AsanaTask_from_json(v: any): AsanaTask | null {
  const gid = str(v?.gid);
  if (gid === null) return null;
  return {
    gid,
    name: str(v.name) ?? "",
    url: str(v.permalink_url) ?? `https://app.asana.com/0/0/${gid}`,
    completed: typeof v.completed === "boolean" ? v.completed : false,
    notes: str(v.notes) ?? "",
    assignee: str(v.assignee?.name),
    projects: Array.isArray(v.projects) ? v.projects.map((p: any) => str(p?.name)).filter((n: string | null) => n !== null) : [],
    workspace: str(v.workspace?.name),
  };
}

/** Why a call to Asana failed, in words for the user (Rust's `asana::Error`; its message is the Display). */
export class AsanaError extends Error {
  /** `Unauthorized`: Asana turned the token down. */
  kind: "Unauthorized" | "NotFound" | "Other";
  constructor(kind: "Unauthorized" | "NotFound" | "Other", other = "") {
    super(
      kind === "Unauthorized"
        ? "Asana didn't accept the token; check it in Asana's developer console, or connect again"
        : kind === "NotFound"
          ? "Asana has no such task, or the token can't see it"
          : `Asana: ${other}`,
    );
    this.kind = kind;
  }
}
export { AsanaError as Error };

async function get(token: string, path: string, query: Array<[string, string]>): Promise<any> {
  let url: URL;
  try {
    url = new URL(`${base_url()}${path}`);
  } catch (e: any) {
    throw new AsanaError("Other", e?.message ?? String(e));
  }
  for (const [k, v] of query) url.searchParams.append(k, v);
  let resp: Response;
  try {
    resp = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  } catch (e: any) {
    throw new AsanaError("Other", e?.cause?.message ?? e?.message ?? String(e));
  }
  let body: any = null;
  try {
    body = await resp.json();
  } catch {}
  const status = resp.status;
  if (status >= 200 && status <= 299) return body?.data ?? null;
  if (status === 401) throw new AsanaError("Unauthorized");
  if (status === 403 || status === 404) throw new AsanaError("NotFound");
  const msg = str(body?.errors?.[0]?.message) ?? `HTTP ${status} ${resp.statusText}`.trim();
  throw new AsanaError("Other", msg);
}

/** Who a token belongs to, which also checks it. */
export async function me(token: string): Promise<User> {
  const v = await get(token, "/users/me", [["opt_fields", "name,email,workspaces"]]);
  return {
    name: str(v?.name) ?? "",
    email: str(v?.email),
    workspaces: Array.isArray(v?.workspaces) ? v.workspaces.map((w: any) => str(w?.gid)).filter((g: string | null) => g !== null) : [],
  };
}

export async function task(token: string, gid: string): Promise<AsanaTask> {
  const v = await get(token, `/tasks/${gid}`, [["opt_fields", TASK_FIELDS]]);
  const t = AsanaTask_from_json(v);
  if (!t) throw new AsanaError("NotFound");
  return t;
}

/**
 * The tasks a search finds: the task a pasted URL (or gid) names, or else those whose names
 * match `q` in each of the user's workspaces (with `q` empty, the ones Asana ranks first,
 * which are those the user looked at lately), open ones first.
 */
export async function search(token: string, q: string): Promise<AsanaTask[]> {
  q = q.trim();
  const gid = task_gid(q);
  if (gid !== null) return [await task(token, gid)];
  const user = await me(token);
  const count = String(SEARCH_RESULTS);
  const found = await Promise.allSettled(
    user.workspaces.map((w) =>
      get(token, `/workspaces/${w}/typeahead`, [["resource_type", "task"], ["query", q], ["count", count], ["opt_fields", TASK_FIELDS]]),
    ),
  );
  const tasks: AsanaTask[] = [];
  for (const f of found) {
    if (f.status === "rejected") throw f.reason;
    if (Array.isArray(f.value)) for (const v of f.value) {
      const t = AsanaTask_from_json(v);
      if (t) tasks.push(t);
    }
  }
  // Stable, so each workspace's keep Asana's order.
  tasks.sort((a, b) => Number(a.completed) - Number(b.completed));
  return tasks;
}

/**
 * The task an Asana task URL (or a bare gid) names: `https://app.asana.com/0/<project>/<task>`
 * (`/f` after it, or `/0/<project>/<task>/<subtask>`), or the newer
 * `https://app.asana.com/1/<workspace>/project/<project>/task/<task>`.
 */
export function task_gid(q: string): string | null {
  const gid = (s: string | undefined) => (s && /^[0-9]+$/.test(s) ? s : null);
  if (Buffer.byteLength(q) >= 10) {
    const g = gid(q);
    if (g !== null) return g;
  }
  let rest: string;
  if (q.startsWith("https://")) rest = q.slice(8);
  else if (q.startsWith("http://")) rest = q.slice(7);
  else return null;
  if (!rest.startsWith("app.asana.com/")) return null;
  const path = rest.slice("app.asana.com/".length).split(/[?#]/)[0];
  const parts = path.split("/").filter((p) => p);
  const i = parts.lastIndexOf("task");
  if (i >= 0) return gid(parts[i + 1]);
  if (parts.length >= 2 && parts[0] === "0") {
    const ids = parts.slice(2);
    if (!ids.length) return null;
    for (const p of [...ids].reverse()) {
      const g = gid(p);
      if (g !== null) return g;
    }
  }
  return null;
}
