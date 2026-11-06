// Port of server/src/agent/codex/queries.rs.
/** One-off queries to Codex: task titles, models, skills and rate limits. */
import { tmpdir } from "node:os";
import { Rpc } from "./rpc.ts";
import { Spent_codex, type Spent } from "../tokens.ts";
import { rfc3339, type Limit } from "../usage.ts";
import type { TaskSkill } from "../agent_tools.ts";
import { context, err_str } from "../../util.ts";

const str = (v: any): string | null => (typeof v === "string" ? v : null);

/** `work`, failing with `err` if it takes over `ms` (tokio's `timeout`). Kills the app-server either way. */
async function within<T>(rpc: Rpc, ms: number, err: () => Error, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(err()), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    rpc.kill();
  }
}

/**
 * A short-lived title query using this config's model and login, without a task session. What it used goes in
 * `spent.value` (Rust's `&mut Option<Spent>`).
 */
export async function task_title(codex_home: string, cwd: string, instructions: string, input: string, spent: { value: Spent | null }): Promise<string> {
  const rpc = Rpc.start(codex_home, cwd);
  const work = (async () => {
    await rpc.initialize();
    // Config overrides merge maps, so an empty map alone would keep the user's servers.
    const config = await rpc.request("config/read", { includeLayers: false, cwd });
    // A cheap model, as Claude's titles use Haiku, rather than the config's default (often its biggest).
    let list = cached_models(codex_home);
    if (list === null) {
      try {
        list = save_models(codex_home, await rpc.request("model/list", {}));
      } catch (e) {
        console.warn(`codex: listing models for a title: ${err_str(e)}`);
        list = [];
      }
    }
    const pick = title_model(list);
    const servers: Record<string, any> = {};
    const have = config?.config?.mcp_servers;
    if (have && typeof have === "object" && !Array.isArray(have)) for (const name of Object.keys(have)) servers[name] = { enabled: false };
    const started = await rpc.request("thread/start", {
      cwd,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: instructions,
      developerInstructions: "",
      ...(pick.model !== null ? { model: pick.model } : {}),
      config: {
        mcp_servers: servers,
        project_doc_max_bytes: 0,
        web_search: "disabled",
        "features.shell_tool": false,
        "features.apply_patch_freeform": false,
        "features.multi_agent": false,
        "features.apps": false,
      },
    });
    const thread = str(started?.thread?.id);
    if (thread === null) throw new Error("no title thread id");
    const m = str(started?.model);
    const model = m !== null && m !== "" ? m : "codex";
    await rpc.request("turn/start", { threadId: thread, effort: pick.effort, input: [{ type: "text", text: input, text_elements: [] }] });
    let title = "";
    for (;;) {
      const msg = await rpc.incoming.recv();
      if (msg === null) break;
      if ("id" in msg) {
        // A title never needs tools or approvals.
        rpc.sender().error(msg.id, "Tools are unavailable while writing a task title");
        continue;
      }
      const p = msg.params ?? {};
      if (str(p.threadId) !== thread) continue;
      switch (msg.method) {
        // Its thread's totals so far (see agent/tokens/calls.rs). Codex (0.166) sends the
        // last of them just before `turn/completed`, and nothing for the thread after it.
        case "thread/tokenUsage/updated":
          spent.value = Spent_codex(model, p.tokenUsage);
          break;
        case "item/completed":
          if (p.item?.type === "agentMessage") title = str(p.item?.text) ?? "";
          break;
        case "turn/completed":
          if (p.turn?.status !== "completed") throw new Error(`codex title turn failed: ${JSON.stringify(p.turn ?? null)}`);
          return title;
      }
    }
    throw new Error("codex app-server exited before writing a title");
  })();
  return within(rpc, 60_000, () => context("codex title timed out", new Error("deadline has elapsed")), work);
}

/** Run a few requests against a short-lived app-server for the config at `codex_home`. */
async function query(codex_home: string, requests: Array<[string, any]>): Promise<any[]> {
  const rpc = Rpc.start(codex_home, tmpdir());
  const work = (async () => {
    await rpc.initialize();
    const out: any[] = [];
    for (const [m, p] of requests) out.push(await rpc.request(m, p));
    return out;
  })();
  return within(rpc, 20_000, () => new Error("codex app-server didn't answer"), work);
}

export interface Model {
  id: string;
  name: string;
  /** What Codex says it's for ("Fast and affordable model for easier tasks"). */
  description?: string;
  is_default: boolean;
  efforts: string[];
  default_effort: string | null;
}

const MODELS = new Map<string, [number, Model[]]>();

/** The models a Codex config can use (cached for 10 minutes). */
export async function models(codex_home: string): Promise<Model[]> {
  const hit = cached_models(codex_home);
  if (hit !== null) return hit;
  const r = await query(codex_home, [["model/list", {}]]);
  return save_models(codex_home, r[0]);
}

/** The models cached for a Codex config, if they're fresh. */
function cached_models(codex_home: string): Model[] | null {
  const hit = MODELS.get(codex_home);
  return hit && performance.now() - hit[0] < 600_000 ? structuredClone(hit[1]) : null;
}

/** Cache the models in a reply to `model/list`, and return them. */
function save_models(codex_home: string, r: any): Model[] {
  const data: any[] = Array.isArray(r?.data) ? r.data : [];
  const list: Model[] = data
    .filter((m) => m?.hidden !== true)
    .map((m) => ({
      id: str(m.model) ?? str(m.id) ?? "",
      name: str(m.displayName) ?? str(m.model) ?? "",
      description: str(m.description) ?? "",
      is_default: m.isDefault === true,
      efforts: (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : []).map((e: any) => str(e?.reasoningEffort)).filter((e: any) => e !== null),
      default_effort: str(m.defaultReasoningEffort),
    }))
    .filter((m) => m.id !== "");
  MODELS.set(codex_home, [performance.now(), list]);
  return structuredClone(list);
}

/** What a model's name or description says when it's a cheap one, and when it's been superseded. */
const CHEAP = /\b(?:mini|nano|lite|small|spark|fast|faster|affordable|efficient|cheap|cheaper|lightweight)\b/i;
const OLD = /\b(?:older|legacy|deprecated|previous)\b/i;

/**
 * The model and effort for a title, from a config's models: the first cheap one (by its id, name or description),
 * current ones before older ones and the default before the rest, or the config's default (null) if none is; at low
 * effort, or the least the model has if it can't do low.
 */
export function title_model(list: Model[]): { model: string | null; effort: string } {
  const text = (m: Model) => `${m.id} ${m.name} ${m.description ?? ""}`;
  const rank = (m: Model) => (OLD.test(text(m)) ? 2 : 0) + (m.is_default ? 0 : 1);
  const cheap = list.filter((m) => CHEAP.test(text(m))).sort((a, b) => rank(a) - rank(b));
  const m = cheap[0] ?? null;
  const effort = m === null || m.efforts.length === 0 || m.efforts.includes("low") ? "low" : m.efforts[0];
  return { model: m?.id ?? null, effort };
}

/** Lists `models` for a Codex config, as if its app-server had (for tests). */
export function set_test_models(codex_home: string, models: Model[]) {
  MODELS.set(codex_home, [performance.now(), models]);
}

const SKILLS = new Map<string, [number, TaskSkill[]]>();

/** The skills a Codex config has in a working directory, for the composer (cached for a minute). */
export async function skills(codex_home: string, cwd: string | null): Promise<TaskSkill[]> {
  const key = JSON.stringify([codex_home, cwd]);
  const hit = SKILLS.get(key);
  if (hit && performance.now() - hit[0] < 60_000) return structuredClone(hit[1]);
  const cwds = cwd !== null ? [cwd] : [];
  const r = await query(codex_home, [["skills/list", { cwds }]]);
  const list: TaskSkill[] = [];
  for (const e of Array.isArray(r[0]?.data) ? r[0].data : []) {
    for (const s of Array.isArray(e?.skills) ? e.skills : []) {
      if (s?.enabled === false) continue;
      const name = str(s?.name);
      if (name === null) continue;
      const short = str(s.shortDescription);
      const description = short !== null && short !== "" ? short : (str(s.description) ?? "");
      list.push({ name, description });
    }
  }
  SKILLS.set(key, [performance.now(), list]);
  return structuredClone(list);
}

/** The account's plan and rate limits, for the usage page. Throws the reason as its message if they can't be read. */
export async function rate_limits(codex_home: string): Promise<[string | null, Limit[]]> {
  let r: any[];
  try {
    r = await query(codex_home, [["account/rateLimits/read", null]]);
  } catch (e) {
    throw new Error(err_str(e));
  }
  const rl = r[0]?.rateLimits;
  return [str(rl?.planType), limits(rl)];
}

/**
 * Codex's windows, told apart by their length (`windowDurationMins`), as Codex's own status
 * does: 5 hours is the session one and a week the weekly one, whichever of `primary` and
 * `secondary` has it (a weekly-only plan's `primary` is weekly). Without a length, `primary` is
 * the session and `secondary` the weekly one; another length is named by it.
 */
export function limits(rl: any): Limit[] {
  const out: Limit[] = [];
  for (const [key, default_id] of [["primary", "session"], ["secondary", "weekly"]]) {
    const w = rl?.[key];
    const used = w?.usedPercent;
    if (typeof used !== "number") continue;
    const m = Number.isInteger(w.windowDurationMins) ? (w.windowDurationMins as number) : null;
    let id: string, label: string;
    if (m === null) [id, label] = default_id === "session" ? ["session", "Session"] : ["weekly", "Weekly"];
    else if (m === 300) [id, label] = ["session", "Session"];
    else if (m === 10080) [id, label] = ["weekly", "Weekly"];
    else if (m % 1440 === 0) [id, label] = [`window:${m}`, `${m / 1440}-day`];
    else if (m % 60 === 0) [id, label] = [`window:${m}`, `${m / 60}-hour`];
    else [id, label] = [`window:${m}`, `${m}-minute`];
    if (out.some((l) => l.id === id)) continue;
    const resets_at = Number.isInteger(w.resetsAt) ? rfc3339(w.resetsAt) : null;
    out.push({ id, label, percent: used, resets_at });
  }
  return out;
}
