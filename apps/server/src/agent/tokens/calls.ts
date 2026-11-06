// Port of server/src/agent/tokens/calls.rs.
/**
 * The tokens of the board's own model calls that aren't runs, in `call_usage` (see
 * db::SCHEMA_V80): task titles (see agent/title.rs) and the prompts that restart 5-hour windows
 * (see agent/window.rs). Each call is counted as it ends, from what its reply says it used:
 * Claude Code's `result` (`modelUsage`, which a call with no session kept has from nothing), or
 * Codex's latest `thread/tokenUsage/updated` for its (ephemeral) thread.
 */
import * as db from "../../db.ts";
import { Counts_from_claude, Counts_from_codex, sorted, total, type ByModel } from "../tokens.ts";
import type { Shared } from "../../state.ts";
import { err_str, new_id, now } from "../../util.ts";

/** What a call used, by model. */
export interface Spent {
  runtime: string;
  models: ByModel;
}

/** From a Claude Code `result` (`--output-format json`'s output, or stream-json's last line). */
export function Spent_claude(result: any): Spent {
  const usage = result?.modelUsage;
  const models: ByModel = {};
  if (usage && typeof usage === "object" && !Array.isArray(usage)) for (const [m, u] of Object.entries(usage)) models[m] = Counts_from_claude(u);
  return { runtime: "claude", models: sorted(models) };
}

/** From the latest `tokenUsage` of a Codex thread started with `model`. */
export function Spent_codex(model: string, usage: any): Spent {
  return { runtime: "codex", models: { [model]: Counts_from_codex(usage?.total) } };
}

/** From the last `result` in Claude Code's stream-json output, if it has one. */
export function Spent_claude_stream(stdout: string): Spent | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('"result"')) continue;
    let v: any;
    try {
      v = JSON.parse(l);
    } catch {
      continue;
    }
    if (v?.type === "result") return Spent_claude(v);
  }
  return null;
}

/**
 * Keep what a call for `purpose` (`title` or `window`) used, for task `task_id` or with config
 * `config_id`. Logs rather than fails: the call's own work is done.
 */
export function record(state: Shared, purpose: string, task_id: string | null, config_id: string | null, spent: Spent) {
  const at = now();
  // The call's rows (one for each model) share it, so they're counted as one call.
  const call_id = new_id();
  const c = state.db();
  for (const [model, n] of Object.entries(sorted(spent.models))) {
    if (!(total(n) > 0 || n.cost > 0)) continue;
    try {
      db.run(
        c,
        `INSERT INTO call_usage (at, purpose, task_id, config_id, model, runtime, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           reasoning_tokens, cost_usd, call_id)
         SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13 WHERE ?3 IS NULL OR EXISTS (SELECT 1 FROM tasks WHERE id=?3)`,
        at,
        purpose,
        task_id,
        config_id,
        model,
        spent.runtime,
        n.input,
        n.output,
        n.cache_read,
        n.cache_write,
        n.reasoning,
        spent.runtime === "claude" ? n.cost : null,
        call_id,
      );
    } catch (e) {
      console.error(new Date().toISOString(), ` WARN tokens: purpose=${purpose} keeping a model call's tokens: ${err_str(e)}`);
    }
  }
}
