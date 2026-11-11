import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Approval, PendingPermission, PermissionAnswer, PermissionAnswered } from "../approval.ts"
import { Conflict, Invalid, NotFound, Unavailable } from "../errors.ts"
import { ProfileId, RequestId, TaskId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"

/**
 * Prompts agents wait on (the old `GET /permissions`, `POST /permissions/{id}` and `GET /project-approvals`): a tool call
 * its thread's mode or an approval rule asks about, Claude's questions, a plan, and the board's own approvals.
 */
export class PermissionRpcs extends RpcGroup.make(
  /** The prompts waiting for an answer, oldest first: all of this host's, a task's, or a profile's. */
  Rpc.make("permissions.pending", {
    payload: { task_id: Schema.optional(TaskId), profile_id: Schema.optional(ProfileId) },
    success: Schema.Array(PendingPermission),
  }).annotate(RequiredScope, "read"),
  /**
   * Answers prompt `id`. The first answer wins: another is `Conflict` (`not_pending`). A question or plan whose run ended
   * first is answered as the user's message, unless the conversation has moved on since (`Conflict`, `moved_on`), and
   * `Unavailable` when that message can't be sent. Answers that don't fit the questions, or a plan's mode `plan`, are
   * `Invalid`.
   */
  Rpc.make("permissions.answer", {
    payload: { id: RequestId, answer: PermissionAnswer },
    success: PermissionAnswered,
    error: Schema.Union([NotFound, Conflict, Invalid, Unavailable]),
  }).annotate(RequiredScope, "operate"),
  /** The board's own approvals waiting for the user, oldest first (the board snapshot's `approvals`). */
  Rpc.make("permissions.approvals", { success: Schema.Array(Approval) }).annotate(RequiredScope, "read"),
).middleware(Auth) {}
