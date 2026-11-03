// A task's agent-threads thread for the components that show it (the thread, its Agents pill, its
// context meter): one ThreadStore per open task, given by a ThreadProvider around the task view.
import { initialState, type Snapshot } from "@dire-kiwi/agent-threads-protocol";
import { ThreadProvider, type CommandHandler, type ThreadConfig, type ThreadSource } from "@dire-kiwi/agent-threads-react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type PermissionMode, type Task } from "../../../api";
import { noThread, onThreadEvents, taskThreadSource, threadEngine, THREAD_PAGE } from "../../../agentThreads";
import { useHost } from "../../../store";
import { config } from "./config";

export interface AgentThreadState {
  hostId: string;
  taskId: string;
  /** legacy: the task is shown with the board's own thread (and the rest of this doesn't apply). */
  engine: "legacy" | "agent_threads";
  status: "loading" | "ready" | "error";
  error: string | null;
  retry: () => void;
}

const Ctx = createContext<AgentThreadState | null>(null);

/** The agent-threads thread of `task`, from the provider around it; null when there's none for it. */
export function useAgentThread(task: Pick<Task, "id" | "host_id">): AgentThreadState | null {
  const s = useContext(Ctx);
  return s && s.taskId === task.id && s.hostId === task.host_id ? s : null;
}

/** Whether `task` is shown with agent-threads' components (its thread is loading, loaded, or failed to load). */
export function useIsAgentThread(task: Pick<Task, "id" | "host_id">): boolean {
  return useAgentThread(task)?.engine === "agent_threads";
}

/** The source of a thread that isn't loaded (or isn't there): nothing in it, and no events. */
const EMPTY: ThreadSource = {
  snapshot: initialState({ id: "", harness: "claude", status: "idle", created_at: "" }) as Snapshot,
  subscribe: () => () => {},
};

/**
 * Gives what's inside it `task`'s agent-threads thread, if it has one: the package's ThreadProvider,
 * and its state (useAgentThread). Inside another for the same task, it's that one's. The tree it
 * makes is the same whatever the task runs on, so a task that moves onto agent-threads (its first run
 * starts) doesn't draw the task view again from scratch.
 */
export function TaskThreadProvider({ task, children }: { task: Task; children: ReactNode }) {
  const outer = useContext(Ctx);
  const host = useHost(task.host_id);
  const engine = threadEngine(task, host);
  if (outer && outer.taskId === task.id && outer.hostId === task.host_id) return <>{children}</>;
  return (
    <Loaded hostId={task.host_id} taskId={task.id} engine={engine}>
      {children}
    </Loaded>
  );
}

type Load = { key: string; status: "loading" | "ready" | "error" | "none"; source: (ThreadSource & { close?: () => void }) | null; error: string | null };

function Loaded({ hostId, taskId, engine, children }: { hostId: string; taskId: string; engine: "agent_threads" | "probe" | "legacy"; children: ReactNode }) {
  const key = `${hostId}\n${taskId}\n${engine}`;
  const [load, setLoad] = useState<Load>({ key, status: "loading", source: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (engine === "legacy") return;
    let gone = false;
    let source: Awaited<ReturnType<typeof taskThreadSource>> | null = null;
    let offWaiting: (() => void) | null = null;
    setLoad((l) => (l.key === key && l.status !== "ready" ? { ...l, status: "loading", error: null } : l));
    taskThreadSource(hostId, taskId, (limit) => api.threadWindow(hostId, taskId, limit), THREAD_PAGE).then(
      (s) => {
        if (gone) return s.close();
        source = s;
        setLoad({ key, status: "ready", source: s, error: null });
      },
      (e) => {
        if (gone) return;
        if (noThread(e)) {
          setLoad({ key, status: "none", source: null, error: null });
          // A task on agent-threads whose thread isn't there yet (its first run is starting): it's
          // loaded once it says something.
          if (engine === "agent_threads") offWaiting = onThreadEvents(hostId, taskId, () => setAttempt((n) => n + 1));
          return;
        }
        setLoad({ key, status: "error", source: null, error: (e as Error).message });
      },
    );
    return () => {
      gone = true;
      source?.close();
      offWaiting?.();
    };
  }, [key, hostId, taskId, engine, attempt]);

  const mine = load.key === key ? load : null;
  // A task tried for a staged thread that has none is the board's own; one on agent-threads whose
  // thread isn't there yet shows as loading until it is.
  const shown: AgentThreadState["engine"] = engine === "legacy" || (engine === "probe" && mine?.status === "none") ? "legacy" : "agent_threads";
  const status: AgentThreadState["status"] = mine?.status === "ready" ? "ready" : mine?.status === "error" ? "error" : "loading";
  const error = mine?.error ?? null;
  const state = useMemo<AgentThreadState>(
    () => ({ hostId, taskId, engine: shown, status, error, retry: () => setAttempt((n) => n + 1) }),
    [hostId, taskId, shown, status, error],
  );
  const source = (shown === "agent_threads" && mine?.status === "ready" && mine.source) || EMPTY;
  const onCommand = useMemo<CommandHandler>(() => commands(hostId, taskId), [hostId, taskId]);
  return (
    <Ctx.Provider value={state}>
      <ThreadProvider source={source} onCommand={onCommand} {...CONFIG}>
        {children}
      </ThreadProvider>
    </Ctx.Provider>
  );
}

const CONFIG: ThreadConfig = config;

/**
 * Where the package's commands go: answers to requests (and compacting, a new session) to the
 * thread's route; a message, a stop and the thread's options through the board's own routes, which
 * keep its gates (docs/agent-threads-api.md).
 */
function commands(hostId: string, taskId: string): CommandHandler {
  return (c) => {
    switch (c.type) {
      case "send":
        return api.send(hostId, taskId, c.text);
      case "interrupt":
        return api.stop(hostId, taskId);
      case "set_options":
        return api.updateTask(hostId, taskId, {
          ...(c.model !== undefined ? { model: c.model } : {}),
          ...(c.effort !== undefined ? { effort: c.effort as Task["effort"] } : {}),
          ...(c.permission_mode !== undefined ? { permission_mode: boardMode(c.permission_mode) } : {}),
        });
      default:
        return api.threadCommand(hostId, taskId, c);
    }
  };
}

/** A protocol permission mode as the board names it. */
export function boardMode(m: string): PermissionMode {
  return (m === "accept_edits" ? "acceptEdits" : m === "bypass" ? "bypassPermissions" : m === "dont_ask" ? "dontAsk" : m) as PermissionMode;
}
