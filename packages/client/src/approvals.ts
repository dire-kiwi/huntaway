import type { AutomationAction, AutomationTrigger } from "./automations";
import { type Http } from "./http";
import type { Status } from "./tasks";

/** What an agent asked to change about a project, shown to the user to approve (API 44). */
export interface ProjectChange {
  project: { id: string; key: string; name: string; host?: string };
  /** The thread that asked. */
  task: { id: string; key?: string; title: string } | null;
  /** Each setting it changes. */
  changes: { field: string; from: unknown; to: unknown; needs_approval: boolean }[];
  /** Why, in the agent's words. */
  reason?: string | null;
}

/** A project an agent asked to add, shown to the user to approve: the folder its agents would work in (API 76). */
export interface ProjectCreation {
  op: "create";
  /** As it would be added (it has no id yet). */
  project: { id: string; key: string; name: string; host?: string };
  /** The thread that asked. */
  task: { id: string; key?: string; title: string } | null;
  /** The profile whose board it's added to. */
  board: string;
  /** The folder, with symlinks resolved. */
  repo_path: string;
  /** False when the folder is created. */
  exists: boolean;
  /** Whether it's a git repository. */
  git: boolean;
  /** The permission mode its tasks get: the host's default. */
  permission_mode: string;
  /** Why, in the agent's words. */
  reason?: string | null;
}

/** A task an agent asked to delete, shown to the user to confirm (API 58). */
export interface TaskDeletion {
  /** The deleted task's project, if it's in one. */
  project: { id: string; key: string; name: string; host?: string } | null;
  /** The thread that asked. */
  task: { id: string; key?: string; title: string } | null;
  delete: { id: string; key: string; title: string; status: Status; branch?: string | null; running?: boolean; subproject?: boolean };
  /** A subproject's tasks, deleted with it. */
  tasks_with_it: { id: string; key: string; title: string; status: Status }[];
  /** Whether the branch (and its tasks' branches) are deleted too. */
  delete_branch: boolean;
  /** Why, in the agent's words. */
  reason?: string | null;
}

interface ApprovalRequest {
  request_id: string;
  status: "pending" | "allowed" | "denied" | "expired";
  note?: string;
  task_id: string;
  created_at?: string;
}

/** A project change waiting for approval: its permission message's data, with the thread (API 44). */
export interface ProjectApproval extends ApprovalRequest {
  kind: "project";
  tool_name: "update_project";
  input: ProjectChange;
}

/** A project an agent asked to add, waiting for approval like a project change (API 76). */
export interface ProjectCreationApproval extends ApprovalRequest {
  kind: "project";
  tool_name: "create_project";
  input: ProjectCreation;
}

/** A task deletion waiting for the user to confirm it, like a project change (API 58). */
export interface DeletionApproval extends ApprovalRequest {
  kind: "delete_task";
  tool_name: "delete_task";
  input: TaskDeletion;
}

/** An automation as an approval shows it (API 67), with the task its message goes to and its tasks' agent config. */
export interface AutomationView {
  /** Empty for one that's being created. */
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  action: AutomationAction;
  /** Whether a webhook's deliveries must be signed with a secret. */
  signed: boolean;
  target?: { id: string; key: string; title: string; status: Status };
  config?: { id: string; name: string; agent: string };
}

/** An automation an agent asked to create, change or delete, shown to the user to approve (API 67). */
export interface AutomationChange {
  op: "create" | "update" | "delete";
  project: { id: string; key: string; name: string; host?: string };
  /** The thread that asked. */
  task: { id: string; key?: string; title: string } | null;
  /** The automation as it would be (or, to delete, as it is). */
  automation: AutomationView;
  /** For a change: the automation as it is. */
  before?: AutomationView;
  /** For a change, what it changes: name, trigger, action, enabled, generate_secret, secret (removed) or rotate_token. */
  changes?: string[];
  /** The host's time zone, which times of day are in. */
  time_zone?: { name: string | null; offset: string };
  /** Why, in the agent's words. */
  reason?: string | null;
}

/** An automation change waiting for the user to approve it, like a project change (API 67). */
export interface AutomationApproval extends ApprovalRequest {
  kind: "automation";
  tool_name: "create_automation" | "update_automation" | "delete_automation";
  input: AutomationChange;
}

/** What only the user decides for an agent, whatever its thread's permission mode. */
export type Approval = ProjectApproval | ProjectCreationApproval | DeletionApproval | AutomationApproval;

export const approvalsApi = ({ on }: Http) => ({
  /** Project changes agents are waiting for the user to approve, oldest first (API 44). */
  /** Older hosts ignore `all` and `automations` and list project changes only (or those and deletions). */
  projectApprovals: (h: string) => on(h).get<Approval[]>("/project-approvals?all=true&automations=true"),
});
