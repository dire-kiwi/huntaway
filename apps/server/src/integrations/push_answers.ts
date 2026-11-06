// Port of server/src/integrations/push_answers.rs (HA-126 and HA-123, on the HA-117 branch).
/**
 * Answering a permission prompt from a notification (Allow and Deny on a push, see push.ts and apps/web/public/sw.js), without
 * the board's token: each push about a prompt carries a token that can only answer that one prompt, once (`POST
 * /api/permissions/{id}/push-answer`).
 *
 * The board that sends the push (the hub, which watches every host's events) mints the token and keeps its hash, so the
 * hub is also where it's checked: the prompt itself may be on a linked host, which the hub then answers through the link
 * as the board's UI would (`/api/h/<host>/permissions/{id}`). Nothing here depends on how the token reaches the device,
 * so a native app's push can carry one too.
 *
 * A token stops working once its prompt has been answered (from the notification or anywhere else) or has expired, which
 * the hub learns from the host's events, or from the host's answer when it missed them (a link that was down). One whose
 * prompt expires (a routine run's, see permissions.expiry) stops at that time too, even if the hub hasn't heard.
 */
import { createHash } from "node:crypto";
import * as db from "../db.ts";
import type { Conn } from "../db.ts";
import { ApiError, Reply, type Req } from "../http.ts";
import type { AppState } from "../state.ts";
import { err_str, new_token, now } from "../util.ts";
import * as hub from "../hosts/hub.ts";
import * as permissions from "../mcp/permissions.ts";

/** How long a token is kept after it's minted, at most: prompts end with their run long before. */
const KEEP_DAYS = 30;

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * A new token that answers prompt `request_id` (of task `task_id`) on host `host_id`. A prompt can have several (each
 * push about it gets one), and the first answer with any of them settles it. A prompt that expires (`expires_at`, from a
 * routine run, see permissions.expiry) can't be answered from its notifications after that, even if the hub hasn't heard
 * yet.
 */
export function mint(c: Conn, host_id: string, request_id: string, task_id: string, expires_at: string | null): string {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString();
  db.run(c, "DELETE FROM push_answer_tokens WHERE created_at < ?1", cutoff);
  const token = new_token();
  // A prompt already settled stays so for its new tokens too.
  const status = db.value<string>(c, "SELECT status FROM push_answer_tokens WHERE request_id=?1 AND host_id=?2 LIMIT 1", request_id, host_id) ?? "pending";
  db.run(
    c,
    "INSERT INTO push_answer_tokens (token_hash, request_id, host_id, task_id, status, created_at, expires_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
    hash(token), request_id, host_id, task_id, status, now(), expires_at,
  );
  return token;
}

/**
 * Prompt `request_id` on `host_id` was answered or expired (`status` and `note`, as its thread message says): its tokens
 * don't answer it any more. One that expired because nobody answered it in time (a routine run's, see
 * permissions.expire_due) is noted as `timed_out`, so a later tap on its notification says so rather than that its run
 * ended.
 */
export function settle(c: Conn, host_id: string, request_id: string, status: string, note: unknown = null): void {
  if (status === "expired" && note === permissions.EXPIRED_UNANSWERED) status = "timed_out";
  db.run(
    c,
    "UPDATE push_answer_tokens SET status=?1 WHERE request_id=?2 AND host_id=?3 AND status IN ('pending','answering')",
    status, request_id, host_id,
  );
}

/**
 * What an answer from a notification came to: `result` is `allowed` or `denied`, or why it wasn't taken (`answered`,
 * `expired`, `closed`, `invalid`, `offline` or `failed`), with `message` to show.
 */
function reply(status: number, result: string, message: string): Reply {
  const ok = status >= 200 && status < 300;
  return new Reply(status, { result, message, error: ok ? null : message });
}

/** Why a settled prompt can't be answered. */
function settled(status: string): Reply {
  switch (status) {
    case "allowed":
      return reply(409, "answered", "It was already allowed.");
    case "denied":
      return reply(409, "answered", "It was already denied.");
    case "answering":
      return reply(409, "answered", "It's being answered from another notification.");
    case "expired":
      return reply(409, "expired", "It expired: the agent's run ended before it was answered.");
    case "timed_out":
      return reply(409, "expired", "It expired: nobody answered it in time, so it was denied.");
    default:
      return reply(409, "closed", "It isn't waiting for an answer any more.");
  }
}

/**
 * How long a claim on a prompt holds (see `answer`): longer than a request to a host can take (5 minutes), so only an
 * answer that was abandoned (its hub stopped part-way) runs out.
 */
const CLAIM_LEASE_MS = 6 * 60_000;

/**
 * `POST /api/permissions/{id}/push-answer` with `{token, decision}` (`allow` or `deny`), without the board's token:
 * answers prompt `id` if `token` is one of its own and it's still waiting.
 */
export async function answer(s: AppState, r: Req): Promise<Reply> {
  const b = r.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) return new Reply(422, { error: "Failed to deserialize the JSON body into the target type" });
  for (const k of ["token", "decision"]) {
    if (typeof b[k] !== "string") {
      return new Reply(422, { error: `Failed to deserialize the JSON body into the target type: missing field \`${k}\`` });
    }
  }
  const id: string = r.params.id;
  let allow: boolean;
  if (b.decision === "allow") allow = true;
  else if (b.decision === "deny") allow = false;
  else return reply(400, "invalid", "decision must be allow or deny");
  const row = db.one<{ host_id: string; status: string; expires_at: string | null }>(
    s.db(),
    "SELECT host_id, status, expires_at FROM push_answer_tokens WHERE token_hash=?1 AND request_id=?2",
    hash(b.token.trim()),
    id,
  );
  if (!row) return reply(403, "invalid", "This notification can't answer that prompt.");
  const waiting = row.status === "pending" || row.status === "answering";
  // Its prompt expired, though its host may not have said so yet.
  if (waiting && row.expires_at !== null && row.expires_at <= now()) return settled("timed_out");
  if (!waiting) return settled(row.status);
  const host = row.host_id;
  // Taken by one answer at a time: a second tap, or another device's, finds it answering. A claim older than any answer
  // takes was abandoned (see CLAIM_LEASE_MS) and can be taken again.
  const stale = new Date(Date.now() - CLAIM_LEASE_MS).toISOString();
  const claimed = db.run(
    s.db(),
    `UPDATE push_answer_tokens SET status='answering', claimed_at=?3 WHERE request_id=?1 AND host_id=?2
     AND (status='pending' OR (status='answering' AND (claimed_at IS NULL OR claimed_at < ?4)))`,
    id, host, now(), stale,
  ).changes;
  if (claimed === 0) {
    const status = db.value<string>(s.db(), "SELECT status FROM push_answer_tokens WHERE request_id=?1 AND host_id=?2", id, host);
    return settled(status ?? "");
  }
  // A device that gives up waiting (the connection dropped) doesn't stop it: the handler carries on, and settles or
  // releases the claim.
  return await forward(s, host, id, allow);
}

/** Abandoned claims: once the board starts again, no answer is under way any more. */
export function recover(c: Conn): void {
  db.run(c, "UPDATE push_answer_tokens SET status='pending', claimed_at=NULL WHERE status='answering'");
}

/** Answers prompt `id` on `host` (which the caller has claimed), and settles or releases the claim. */
async function forward(s: AppState, host: string, id: string, allow: boolean): Promise<Reply> {
  const release = (status: string) => {
    try {
      db.run(
        s.db(),
        "UPDATE push_answer_tokens SET status=?1, claimed_at=NULL WHERE request_id=?2 AND host_id=?3 AND status='answering'",
        status, id, host,
      );
    } catch {}
  };
  const offline = () => reply(503, "offline", "Its host is offline: try again once it's back, or answer it on the board.");
  const linked = () => host === s.host_id || s.links.has(host);
  const decision = allow ? "allow" : "deny";
  const path = `/api/permissions/${encodeURIComponent(id)}`;
  try {
    await hub.host_request(s, host, "POST", path, { decision, via: "push" });
  } catch (e) {
    const code = e instanceof ApiError ? e.status : 502;
    const msg = e instanceof ApiError ? e.message : err_str(e);
    // Its host isn't linked (host_request says so with a 409, as a prompt that's no longer pending does): the prompt
    // still waits, and the token keeps working.
    if (code === 409 && (!linked() || msg.endsWith("is offline"))) {
      release("pending");
      return offline();
    }
    // Answered on the board meanwhile, expired, or gone with its thread.
    if (code === 409 || code === 404) {
      release("closed");
      return settled("closed");
    }
    release("pending");
    console.warn(`answering prompt ${id} on ${host} from a notification: ${msg}`);
    return reply(502, "failed", `It couldn't be answered: ${msg}`);
  }
  const status = allow ? "allowed" : "denied";
  release(status);
  return reply(200, status, allow ? "Allowed." : "Denied.");
}

/**
 * Whether Allow and Deny can answer a prompt from a notification, by its thread message (`data`, see mcp/permissions.ts):
 * tool permissions can. Questions (which need answers), plans (worth reading first) and approvals of changes to the board
 * (projects, deletions, automations) open the thread instead.
 */
export function answerable(data: any): boolean {
  const tool = typeof data?.tool_name === "string" ? data.tool_name : "";
  const kind = data?.kind;
  return (kind == null || kind === "tool") && !permissions.is_question(tool) && tool !== permissions.EXIT_PLAN;
}

/** The status of a prompt's tokens (for tests). */
export function status_of(c: Conn, request_id: string): string | null {
  return db.value<string>(c, "SELECT status FROM push_answer_tokens WHERE request_id=?1 LIMIT 1", request_id) ?? null;
}
