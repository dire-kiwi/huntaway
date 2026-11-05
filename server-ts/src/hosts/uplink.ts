// Port of server/src/hosts/uplink.rs (HA-120, on the HA-117 branch).
/**
 * Board tools up the link: a host's agents using the board of a hub it's linked to (API 111).
 *
 * Links are made by the hub, which calls the host (over HTTP, or through the tunnel a host opens with `--hub`), so a host
 * had no way to ask the hub anything. Now the hub says who it is once it's connected (`{"type": "hub_hello"}` on
 * `/api/host/ws`, or `Down::Hello` on the tunnel), and the host keeps it here as an up-link while that connection lasts. A
 * board tool call that the host can't resolve on its own board or its own links (a project or task on the hub's, say)
 * goes up each of them (`{"type": "hub_call"}` or `Up::ToolCall`), and the hub answers (`hub_result` or
 * `Down::ToolAnswer`).
 *
 * The hub runs it only if its user lets that host's agents use its board (`links.uplink`, Settings → Hosts, off by
 * default), and only for a caller in one of its profiles whose assistant runs on that host (`assistant_host`): whoever
 * controls the host can name any profile, so the name alone proves nothing. It runs with the access of that profile
 * (`agent_access`), at most once per call id, and never further up: see `hub::run_up_call`.
 */
import type { AppState } from "../state.ts";
import { API_VERSION, type ToolAnswer, type ToolCall } from "./proto.ts";
import { Chan } from "./relay.ts";

/** How long a call up the link may take: the hub's own tools answer at once, but it may ask its other hosts. */
let TIMEOUT_MS = 300_000;

/** Tests: a shorter TIMEOUT. */
export function test_timeout(ms: number) {
  TIMEOUT_MS = ms;
}

/** What a call up the link came to. */
export type Outcome =
  | { kind: "Ok"; value: any }
  | { kind: "Err"; error: string }
  /** The hub doesn't let this host's agents use its board, or not in the caller's profile (with the hub's reason for that). */
  | { kind: "Off"; why: string | null };

/** A hub this host is linked to that takes its agents' board tool calls. */
export class Uplink {
  hub_id: string;
  hub_name: string;
  /** Where the calls to send it go (Rust's `mpsc::UnboundedSender`): the connection takes them out of it. */
  tx: Chan<ToolCall>;
  /** The calls waiting for answers, by id: each is answered (or, null, given up on) once. */
  pending = new Map<number, (a: ToolAnswer | null) => void>();
  next = 1;

  constructor(hub_id: string, hub_name: string, tx: Chan<ToolCall>) {
    this.hub_id = hub_id;
    this.hub_name = hub_name;
    this.tx = tx;
  }

  /** Pass a board tool call to the hub, and wait for its answer. */
  async call(call_id: string, tool: string, profile: string, args: any, task_fields: boolean): Promise<Outcome> {
    const id = this.next++;
    let timer: NodeJS.Timeout | undefined;
    const answer = new Promise<ToolAnswer | null | "timeout">((resolve) => {
      this.pending.set(id, resolve);
      timer = setTimeout(() => resolve("timeout"), TIMEOUT_MS);
    });
    const call: ToolCall = { id, call_id, tool, profile, args: args ?? null, task_fields };
    if (!this.tx.send(call)) {
      clearTimeout(timer);
      this.pending.delete(id);
      return { kind: "Err", error: `lost the link to ${this.hub_name}, so this ${tool} call wasn't sent there` };
    }
    // Once it's sent, the hub may have run it whatever becomes of the answer.
    const maybe = (what: string) =>
      `${what}: this ${tool} call may or may not have taken effect there. Check (with get_task or list_tasks, say) before you call it again.`;
    const a = await answer;
    clearTimeout(timer);
    if (a === "timeout") {
      this.pending.delete(id);
      return { kind: "Err", error: maybe(`${this.hub_name} didn't answer in time`) };
    }
    if (a === null) return { kind: "Err", error: maybe(`lost the link to ${this.hub_name} before it answered`) };
    if (a.off) return { kind: "Off", why: a.error };
    if (a.error !== null) return { kind: "Err", error: a.error };
    return { kind: "Ok", value: a.result ?? null };
  }

  /** The hub's answer to one of our calls. */
  answer(a: ToolAnswer) {
    const w = this.pending.get(a.id);
    if (w) {
      this.pending.delete(a.id);
      w(a);
    }
  }
}

/**
 * An up-link, counted as this host's until `drop` (Rust drops it): then it's gone, and its calls waiting for answers
 * fail.
 */
export class Registered {
  private s: AppState;
  link: Uplink;
  private dropped = false;

  constructor(s: AppState, link: Uplink) {
    this.s = s;
    this.link = link;
  }

  drop() {
    if (this.dropped) return;
    this.dropped = true;
    if (this.s.uplinks.get(this.link.hub_id) === this.link) this.s.uplinks.delete(this.link.hub_id);
    this.link.tx.close();
    const waiting = [...this.link.pending.values()];
    this.link.pending.clear();
    for (const w of waiting) w(null);
  }
}

/**
 * Count the hub `hub_id` that just said hello on a connection as an up-link, in place of any earlier connection of its.
 * The calls to send it come out of the channel.
 */
export function register(s: AppState, hub_id: string, hub_name: string): [Registered, Chan<ToolCall>] {
  const calls = new Chan<ToolCall>();
  const link = new Uplink(hub_id, hub_name, calls);
  s.uplinks.set(hub_id, link);
  console.error(`hub ${hub_name} takes this host's board tool calls`);
  return [new Registered(s, link), calls];
}

/** The hubs this host's agents can ask, but not those it's linked to itself, whose boards it already asks the other way (with their tokens). */
export function hubs(s: AppState): Uplink[] {
  return [...s.uplinks.values()].filter((u) => !s.links.has(u.hub_id)).sort((a, b) => (a.hub_name < b.hub_name ? -1 : a.hub_name > b.hub_name ? 1 : 0));
}

// ---------- on `/api/host/ws` ----------

/** What the hub says on `/api/host/ws` when it connects (hubs from API 111). */
export function hub_hello(s: AppState): any {
  return { type: "hub_hello", hub_id: s.host_id, name: s.host_name, api_version: API_VERSION };
}

/** A call as it goes to the hub on `/api/host/ws`. */
export function call_frame(c: ToolCall): any {
  return { ...c, type: "hub_call" };
}

/** An answer as it comes back on `/api/host/ws`. */
export function answer_frame(a: ToolAnswer): any {
  return { ...a, type: "hub_result" };
}
