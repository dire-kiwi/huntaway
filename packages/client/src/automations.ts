import { enc, type Http } from "./http";
import { type Host, hostSupports } from "./hosts";
import type { DocumentType } from "./labels";
import type { Status, TaskType } from "./tasks";

/** Routines (API 110): a profile's automations, which wake its assistant (`message_assistant`), and for every automation
 *  the `cron` and `at` triggers, active hours, a precheck and a budget a day (see apps/server/src/integrations/automations.ts). */
export const ROUTINES_API = 110;

export const hasRoutines = (h: Host | undefined) => hostSupports(h, ROUTINES_API);

/** What starts an automation (API 63): an interval, a time of day (in the host's time zone) on some weekdays, or a webhook
 *  delivery; since API 110 a cron expression (5 fields, in the host's time zone) or a moment (`at`, once, then it's off). */
export type AutomationTrigger =
  | { kind: "interval"; every_minutes: number }
  | { kind: "daily"; time: string; weekdays: Weekday[] }
  | { kind: "cron"; expr: string }
  | { kind: "at"; at: string }
  | { kind: "webhook"; filters: AutomationFilter[]; coalesce_seconds: number; coalesce_key: string };

/** The hours an automation's scheduled runs may start in (`end` may be past midnight), on `weekdays` (none for every day). */
export interface ActiveHours {
  start: string;
  end: string;
  weekdays: Weekday[];
}

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export const FILTER_OPS = ["equals", "not_equals", "starts_with", "contains", "in", "not_in", "exists", "not_exists"] as const;

export type FilterOp = (typeof FILTER_OPS)[number];

/** A condition on a webhook delivery: `path` names a value as templates do (`event`, `action`, `labels`, `body.issue.title`…). */
export interface AutomationFilter {
  path: string;
  op: FilterOp;
  /** A string, or a list (or comma-separated string) for `in` and `not_in`. */
  value: string | string[] | null;
}

/** What an automation does: create a task in its project from templates, or send a message to one of its tasks. */
export type AutomationAction =
  | {
      kind: "create_task";
      title: string;
      description: string;
      /** A label as its type, in an action saved before API 71. */
      task_type: TaskType | DocumentType | null;
      /** API 71. */
      labels?: DocumentType[];
      claude_config_id: string | null;
      model: string | null;
      effort: string | null;
      status: "todo" | "backlog";
      start: boolean;
    }
  | { kind: "send_to_task"; task_id: string; message: string }
  /** A routine's (API 110): in a fresh thread under the assistant, whose report is posted to it, or in its own thread. */
  | { kind: "message_assistant"; message: string; mode: "fresh" | "thread" };

export type AutomationRunStatus = "pending" | "coalesced" | "running" | "ok" | "failed" | "skipped" | "filtered" | "duplicate" | "rejected";

/** A run of an automation, or a webhook delivery that didn't make one. */
export interface AutomationRun {
  id: string;
  automation_id: string;
  source: "schedule" | "webhook" | "manual";
  status: AutomationRunStatus;
  detail: string | null;
  task_id: string | null;
  /** The task it created or messaged, if it's still there. */
  task?: { key: string; title: string; status: Status; running?: boolean };
  delivery_id: string | null;
  /** A delivery's event and action, e.g. `issues.opened`. */
  event: string | null;
  /** Deliveries coalesced into it. */
  count: number;
  batch_id: string | null;
  due_at: string | null;
  created_at: string;
  finished_at: string | null;
  /** A routine's run in a thread of its own, once its agent stopped (API 110): quiet (nothing to report), reported, asked
   *  (it waits for the user), stopped or failed. */
  outcome?: "quiet" | "reported" | "asked" | "stopped" | "failed" | null;
  /** What its agent's runs cost: once they ended, or so far for a routine thread still working (API 110). */
  cost_usd?: number | null;
}

/** A project's automation (API 63), or a profile's routine (API 110, with no project). */
export interface Automation {
  id: string;
  /** API 110. */
  profile_id?: string;
  project_id: string | null;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  action: AutomationAction;
  /** When its schedule next runs; null for a webhook, or while it's off. */
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
  /** A webhook's path on its host (`/api/hooks/<id>/<token>`). */
  hook_path?: string;
  /** Whether a webhook checks deliveries' signatures (the secret itself is never sent back). */
  has_secret?: boolean;
  last_run: AutomationRun | null;
  /** API 110. */
  active_hours?: ActiveHours | null;
  /** A bash command run first: exit 1 skips the run, and what it prints is `{{precheck}}` (API 110). */
  precheck?: string | null;
  /** What its runs may cost a day (API 110). */
  budget_usd?: number | null;
  /** What its runs kept cost, and today's (API 110). */
  cost_usd?: number;
  cost_today_usd?: number;
}

export interface AutomationInput {
  name?: string;
  enabled?: boolean;
  trigger?: AutomationTrigger;
  action?: AutomationAction;
  /** A webhook's signing secret; "" removes it. */
  secret?: string;
  /** A new webhook URL (the old one stops working). */
  rotate_token?: boolean;
  /** API 110; null clears them. */
  active_hours?: ActiveHours | null;
  precheck?: string | null;
  budget_usd?: number | null;
}

export const automationsApi = ({ on }: Http) => ({
  /** The project's automations, and the time zone their times of day are in (API 63). */
  automations: (h: string, projectId: string) =>
    on(h).get<{ automations: Automation[]; time_zone: { name: string | null; offset: string } }>(`/projects/${enc(projectId)}/automations`),
  createAutomation: (h: string, projectId: string, b: AutomationInput) => on(h).post<Automation>(`/projects/${enc(projectId)}/automations`, b),
  /** The profile's routines, and the time zone their times are in (API 110). */
  routines: (h: string, profileId: string) =>
    on(h).get<{ automations: Automation[]; time_zone: { name: string | null; offset: string } }>(`/profiles/${enc(profileId)}/automations`),
  createRoutine: (h: string, profileId: string, b: AutomationInput) => on(h).post<Automation>(`/profiles/${enc(profileId)}/automations`, b),
  updateAutomation: (h: string, id: string, b: AutomationInput) => on(h).patch<Automation>(`/automations/${enc(id)}`, b),
  deleteAutomation: (h: string, id: string) => on(h).del(`/automations/${enc(id)}`),
  /** Run it now; for a webhook, a test delivery of `payload` (else the latest delivery's) as `event`. */
  runAutomation: (h: string, id: string, b: { payload?: unknown; event?: string } = {}) => on(h).post<AutomationRun>(`/automations/${enc(id)}/run`, b),
  /** Its latest runs and deliveries, newest first, and the latest delivery's body and event. */
  automationRuns: (h: string, id: string) =>
    on(h).get<{ runs: AutomationRun[]; latest_delivery: { body: unknown; event: string | null } | null }>(`/automations/${enc(id)}/runs`),
});
