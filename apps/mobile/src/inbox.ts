// The inbox: what's waiting for the user on every paired board together, each item labelled with its board. For each
// board, its picked profile's tasks that need attention (its assistant's included), their pending permission prompts
// (answered in place, the assistant's routine threads' too), and the questions their agents asked with request_user_input
// (answered in place). A task with a prompt or a question shows once, as that.
import { isScratch, type Client, type Message, type PendingPermission, type Project, type Task } from "@huntaway/client";
import { loadProfiles, pickedProfile } from "./boardData";
import { openItemQuestion } from "./thread";

export interface BoardRef {
  id: string;
  name: string;
}

interface Base {
  /** Unique across boards. */
  key: string;
  board: BoardRef;
  /** The host the task is on (a board's hub links other hosts). */
  hostId: string;
  /** The task's key, such as HA-12. */
  taskKey: string;
  taskId: string;
  title: string;
  /** When it started waiting, for the order. */
  at: string;
}

export type InboxItem =
  | (Base & { kind: "permission"; permission: PendingPermission })
  | (Base & { kind: "question"; message: Message })
  | (Base & { kind: "attention"; reason: string | null });

/** One board's items, or why they couldn't be read. */
export interface BoardInbox {
  board: BoardRef;
  items: InboxItem[];
  error?: string;
}

/** What goes before a task's number: its project's key, `G` for a group task, `S` for a scratch task. */
export function taskKey(t: Task, projects: Pick<Project, "id" | "key">[]) {
  const project = projects.find((p) => p.id === t.project_id);
  const prefix = project?.key ?? (t.project_id ? "T" : t.group_name ? "G" : isScratch(t) ? "S" : "T");
  return `${prefix}-${t.number}`;
}

/** The question an agent asked with request_user_input that's still open, among a thread's latest messages. */
export function openQuestion(messages: Message[]): Message | undefined {
  const last = [...messages].reverse().find((m) => m.kind === "question");
  if (!last || last.data?.status !== "pending") return undefined;
  // A reply typed in the thread since settles it too.
  if (messages.some((m) => m.kind === "user" && m.id > last.id)) return undefined;
  return last;
}

/** One host's items for a profile, from its tasks, pending prompts and the open questions of the tasks needing attention. */
export function hostItems(
  board: BoardRef,
  hostId: string,
  tasks: Task[],
  projects: Pick<Project, "id" | "key">[],
  permissions: PendingPermission[],
  questions: Map<string, Message>,
): InboxItem[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const base = (t: Task | undefined, taskId: string, at: string) => ({
    board,
    hostId,
    taskId,
    taskKey: t ? taskKey(t, projects) : "",
    title: t?.title ?? "A task",
    at,
  });
  const items: InboxItem[] = [];
  const covered = new Set<string>();
  for (const p of permissions) {
    // Only the profile's own tasks' (the board filters by profile; this keeps it so for one that doesn't).
    const t = byId.get(p.task_id);
    if (!t) continue;
    covered.add(p.task_id);
    items.push({ ...base(t, p.task_id, p.created_at), kind: "permission", key: `${board.id}/${hostId}/perm/${p.id}`, permission: p });
  }
  for (const [taskId, m] of questions) {
    const t = byId.get(taskId);
    if (!t) continue;
    covered.add(taskId);
    items.push({ ...base(t, taskId, m.created_at), kind: "question", key: `${board.id}/${hostId}/q/${m.id}`, message: m });
  }
  for (const t of tasks) {
    if (t.status !== "needs_attention" || covered.has(t.id)) continue;
    items.push({ ...base(t, t.id, t.updated_at), kind: "attention", key: `${board.id}/${hostId}/task/${t.id}`, reason: t.attention_reason });
  }
  return items;
}

/** Every board's items together, newest first, and the boards that couldn't be read. */
export function mergeInbox(inboxes: BoardInbox[]): { items: InboxItem[]; errors: { board: BoardRef; error: string }[] } {
  const items = inboxes.flatMap((i) => i.items);
  const seen = new Set<string>();
  const unique = items.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)));
  unique.sort((a, b) => (a.at === b.at ? a.board.name.localeCompare(b.board.name) || a.key.localeCompare(b.key) : a.at < b.at ? 1 : -1));
  return { items: unique, errors: inboxes.filter((i) => i.error).map((i) => ({ board: i.board, error: i.error! })) };
}

/**
 * The tasks of `profileId` with a pending prompt that its task list leaves out: the assistant's routine threads, which
 * no list includes, so that a routine waiting on approval shows (and doesn't expire unseen). Each is fetched and kept
 * only if it's the profile's.
 */
export async function promptedTasks(
  client: Pick<Client, "task">,
  hostId: string,
  profileId: string,
  listed: Task[],
  permissions: PendingPermission[],
): Promise<Task[]> {
  const have = new Set(listed.map((t) => t.id));
  const missing = [...new Set(permissions.map((p) => p.task_id).filter((id) => !have.has(id)))];
  const got = await Promise.all(missing.map((id) => client.task(hostId, id).then((d) => d.task).catch(() => null)));
  return got.filter((t): t is Task => !!t && t.profile_id === profileId);
}

/**
 * Reads one board's inbox for its profile `profile` (a name), resolved as everywhere else in the app (pickedProfile):
 * that name if the board has it, else the first in its merged list, on every host that has it.
 */
export async function loadBoardInbox(client: Client, board: BoardRef, profile: string | null): Promise<BoardInbox> {
  try {
    const profiles = await loadProfiles(client, board.id);
    const name = pickedProfile({ profile }, profiles);
    const on = name ? (profiles.byName.get(name) ?? []) : [];
    const lists = await Promise.all(
      on.map(async ({ hostId, profile: p }) => {
        const [listed, projects, permissions] = await Promise.all([
          // With the assistant (a board from before API 109 ignores the flag and has none).
          client.profileTasks(hostId, p.id, true),
          client.projects(hostId, p.id).catch(() => [] as Project[]),
          client.pendingPermissions(hostId, { profile_id: p.id }),
        ]);
        const tasks = [...listed, ...(await promptedTasks(client, hostId, p.id, listed, permissions))];
        const questions = new Map<string, Message>();
        await Promise.all(
          tasks
            .filter((t) => t.status === "needs_attention")
            .map(async (t) => {
              // A task whose items are its thread's source (API 122) has no messages since it moved onto them.
              let q: Message | undefined;
              if (t.thread_source === "items") {
                const w = await client.thread<{ requests?: unknown[] }>(hostId, t.id, 20).catch(() => null);
                q = w ? openItemQuestion(t.id, w.requests ?? []) : undefined;
              } else {
                const page = await client.messagePage(hostId, t.id, { limit: 20 }).catch(() => null);
                q = page ? openQuestion(page.messages) : undefined;
              }
              if (q) questions.set(t.id, q);
            }),
        );
        return hostItems(board, hostId, tasks, projects, permissions, questions);
      }),
    );
    return { board, items: lists.flat() };
  } catch (e) {
    return { board, items: [], error: e instanceof Error ? e.message : String(e) };
  }
}
