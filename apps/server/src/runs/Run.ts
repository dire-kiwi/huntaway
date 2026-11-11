import { Schema } from "effect"
import { RunId, TaskId, Timestamp } from "@huntaway/contracts"
import { Bit } from "../platform/columns.ts"

// A run (docs/plan/07-agents.md, The run): one agent process working on one thread, as the `runs` table records it.
// Server-side only, so it is a class with methods. The rules of its columns are inventory 01, sections 3 and 9.

/** `preparing` (registered, being set up) → `running` (the shim has started it) → `exited`. The `status` column. */
export const RunPhase = Schema.Literals(["preparing", "running", "exited"])
export type RunPhase = typeof RunPhase.Type

/** `none`; `requested` (a stop was asked, its turn has not ended); `interrupted` (the interrupted turn ended). */
export const StopState = Schema.Literals(["none", "requested", "interrupted"])
export type StopState = typeof StopState.Type

/** `prompt` (a message), `compact` (`/compact`: takes no input, never moves the card), `review` (a reviewer's run). */
export const RunKind = Schema.Literals(["prompt", "compact", "review"])
export type RunKind = typeof RunKind.Type

export class Run extends Schema.Class<Run, { readonly brand: unique symbol }>("Run")({
  /** Order of starting: "a later run" is a higher seq. */
  seq: Schema.Int,
  id: RunId,
  task_id: TaskId,
  kind: RunKind,
  phase: RunPhase,
  /** Bytes of `out.jsonl` applied. */
  out_offset: Schema.Int,
  stop: StopState,
  /** `stop-<uuid>`: the latest stop's id, also its interrupt's `request_id`, so an older stop's timer ignores a newer. */
  stop_id: Schema.NullOr(Schema.String),
  /** Its last turn has ended and nothing has started another. */
  between_turns: Bit,
  /** At least one turn ended. */
  saw_result: Bit,
  /** The error of the last turn's result (null: it was fine). */
  result_error: Schema.NullOr(Schema.String),
  /** The agent asked the user something (`request_user_input`): the run ends in Needs attention with it. */
  attention: Schema.NullOr(Schema.String),
  /** The agent called `finish_work`. */
  finished: Bit,
  /** The agent session the run is in. */
  session_id: Schema.NullOr(Schema.String),
  /** The session's running total at its last result (see `RunRepo.addCost`). */
  session_cost: Schema.NullOr(Schema.Finite),
  /** What this run added. */
  cost_usd: Schema.Finite,
  /** The config folder it was started with ("" for the agent's default); the first run of a session pins its folder. */
  config_dir: Schema.NullOr(Schema.String),
  /** Effort as given to the agent ("" for its default). */
  effort: Schema.NullOr(Schema.String),
  /** Codex: this run gave the new session the board's tools as dynamic tools. */
  board_tools: Bit,
  /** Claude: uuid of the latest top-level message; Codex: the current turn's id (the rewind target). */
  agent_at: Schema.NullOr(Schema.String),
  /** The thread write its current turn started with (checkpoints). */
  write_no: Schema.NullOr(Schema.Int),
  /** Context size at the first and the latest model request of the current turn. */
  turn_start_tokens: Schema.NullOr(Schema.Int),
  turn_tokens: Schema.NullOr(Schema.Int),
  created_at: Timestamp,
  ended_at: Schema.NullOr(Timestamp),
}) {
  /** It has not exited: it is being prepared or its agent is (or may be) working. */
  get isLive(): boolean {
    return this.phase !== "exited"
  }

  /**
   * It may take a message as it works: live and not a compaction (which reads its prompt and nothing more). Whether
   * its agent still reads input is the folder's to say (`RunDir.acceptsInput`).
   */
  get acceptsInput(): boolean {
    return this.isLive && this.kind !== "compact"
  }
}

/** How a run ended (docs/plan/07-agents.md, When a run ends). */
export type Outcome = { readonly _tag: "Ok" } | { readonly _tag: "Cancelled" } | { readonly _tag: "Failed"; readonly reason: string }

export const Outcome = {
  ok: { _tag: "Ok" } as Outcome,
  cancelled: { _tag: "Cancelled" } as Outcome,
  failed: (reason: string): Outcome => ({ _tag: "Failed", reason }),
}
