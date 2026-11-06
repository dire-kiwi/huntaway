// A thread on the phone, as the task screen and the Assistant tab show it: its messages (the agent's as markdown, with
// its reply streaming in), the prompts and questions it waits on, kept current from the board's events, with earlier
// pages on request.
import type { Client, Message, Task } from "@huntaway/client";
import { apply_event, is_gap, with_page, type ItemPage, type Snapshot, type ThreadEvent } from "@huntaway/client/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { Markdown } from "./markdown";
import { PermissionCard, QuestionCard, toolSummary } from "./prompts";
import { useBoardEvents, useLoad } from "./session";
import { colors } from "./theme";
import { applyDelta, endsDelta, hiddenUser, itemThreadItems, threadItems, withMessage, type ThreadItem } from "./thread";
import { Button, Empty, ErrorText, s } from "./ui";

const PAGE = 60;
/** A thread kept as items loads a window of this many items (and pages of as many), which its tool calls are most of. */
const ITEMS = 150;

/**
 * A thread as it's loaded: its messages (with whether there are earlier ones), or for a task whose items are its
 * source (API 122, which has no messages since it moved onto them), the window of its items (`snap`), with its earlier
 * pages put in as they load and its `thread_event`s folded in (`more` while the window starts above 0).
 */
interface Loaded {
  messages: Message[];
  more: boolean;
  subagents: unknown[];
  snap?: Snapshot;
}

/** A thread kept as items, whose window (or what's loaded of it) is `snap`. */
const onItems = (snap: Snapshot): Loaded => ({ messages: [], more: (snap.start ?? 0) > 0, subagents: [], snap });

/** Task `id`'s thread, from its items if they're its source, else its latest page of messages. */
async function loadThread(client: Client, host: string, id: string): Promise<Loaded> {
  const task = (await client.task(host, id)).task;
  if (task?.thread_source !== "items") return client.messagePage(host, id, { limit: PAGE });
  return onItems(await client.thread<Snapshot>(host, id, ITEMS));
}

/** Task `id` on host `host` of board `boardId`, and its thread, kept current. */
export function useThread(boardId: string, client: Client | undefined, host: string, id: string) {
  const detail = useLoad(async () => (client && id ? (await client.task(host, id)).task : undefined), [boardId, host, id]);
  const thread = useLoad(
    async (): Promise<Loaded> => (client && id ? loadThread(client, host, id) : { messages: [], more: false, subagents: [] }),
    [boardId, host, id],
  );
  // A thread kept as items is loaded again when its events can't be folded into what's loaded (some were missed, or it
  // was rebuilt), or it moves onto them: at most every half a second.
  const again = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadSoon = () => {
    if (again.current) return;
    again.current = setTimeout(() => {
      again.current = null;
      thread.reload();
    }, 500);
  };
  useEffect(
    () => () => {
      if (again.current) clearTimeout(again.current);
      again.current = null;
    },
    [boardId, host, id],
  );
  // The streamed reply and a request for earlier messages belong to one thread: the Assistant tab keeps this mounted
  // when it shows another profile's assistant, so what's left of the last thread's is kept apart and dropped.
  const key = `${boardId}/${host}/${id}`;
  const current = useRef(key);
  current.current = key;
  const [streamed, setStreamed] = useState({ key, text: "" });
  const delta = streamed.key === key ? streamed.text : "";
  const setDelta = (f: (d: string) => string) => setStreamed((was) => ({ key, text: f(was.key === key ? was.text : "") }));
  const [olderState, setOlderState] = useState<{ key: string; busy: boolean; error: string | null }>({ key, busy: false, error: null });
  const mine = olderState.key === key;
  const olderBusy = mine && olderState.busy;
  const olderError = mine ? olderState.error : null;

  useBoardEvents((b, ev) => {
    if (b !== boardId || !id) return;
    if (ev.type === "resync") {
      detail.reload();
      thread.reload();
      return;
    }
    if (ev.host_id !== host) return;
    if (ev.type === "task" && ev.task?.id === id) {
      detail.setData(ev.task as Task);
      // It moved onto items: its rows are its items' from now on.
      if ((ev.task as Task).thread_source === "items" && thread.data && !thread.data.snap) reloadSoon();
    } else if ((ev.type === "message" || ev.type === "message_updated") && ev.task_id === id) {
      const m = ev.message as Message;
      if (endsDelta(m)) setDelta(() => "");
      // A thread kept as items has its thread_events for it.
      if (!thread.data?.snap)
        thread.setData((t) => (t?.snap ? t : { ...t, more: t?.more ?? false, subagents: t?.subagents ?? [], messages: withMessage(t?.messages ?? [], m) }));
    } else if (ev.type === "thread_event" && ev.task_id === id && ev.event?.type !== "delta" && (thread.data?.snap || thread.loading)) {
      // Folded into what's loaded (and into a window being loaded, once it's in). One that shows events were missed
      // loads it again, unless that's under way.
      const e = ev.event as ThreadEvent;
      if (thread.data?.snap && !thread.loading && is_gap(thread.data.snap, e)) return reloadSoon();
      thread.setData((t) => {
        if (!t?.snap || is_gap(t.snap, e)) return t!;
        const snap = apply_event(t.snap, e);
        return snap === t.snap ? t : onItems(snap);
      });
    } else if (ev.type === "thread_resync" && ev.task_id === id && thread.data?.snap) {
      // Rebuilt: what's loaded may not be its thread now.
      reloadSoon();
    } else if ((ev.type === "delta" || ev.type === "delta_reset") && ev.task_id === id) setDelta((d) => applyDelta(d, ev));
  });

  const items = useMemo(() => {
    const d = thread.data;
    const rows = d?.snap ? itemThreadItems(d.snap.items, d.snap.requests, d.snap.context?.length ?? 0) : threadItems(d?.messages ?? []);
    return rows.filter((it) => !hiddenUser(it));
  }, [thread.data]);
  // Newest first, for the inverted list.
  const shown = useMemo(() => [...items].reverse(), [items]);

  const older = async () => {
    const first = thread.data?.messages[0];
    const start = thread.data?.snap?.start;
    if (!client || (!first && !start)) return;
    const asked = key;
    setOlderState({ key: asked, busy: true, error: null });
    let error: string | null = null;
    try {
      if (start) {
        const page = await client.threadItems<ItemPage>(host, id, start, ITEMS);
        if (current.current === asked) {
          thread.setData((t) => {
            if (!t?.snap) return t!;
            // What the window has already (its context items, its requests) stays as its events have left it.
            const items = new Map(t.snap.items.map((i) => [i.id, i]));
            const requests = new Map(t.snap.requests.map((r) => [r.id, r]));
            const snap = with_page(t.snap, {
              ...page,
              items: page.items.map((i) => items.get(i.id) ?? i),
              requests: page.requests.map((r) => requests.get(r.id) ?? r),
            });
            return snap === t.snap ? t : onItems(snap);
          });
        }
      } else {
        const page = await client.messagePage(host, id, { before: first!.id, limit: PAGE });
        // Another thread's shown now: these aren't its messages.
        if (current.current === asked) {
          thread.setData((t) => {
            const have = new Set((t?.messages ?? []).map((m) => m.id));
            return { more: page.more, subagents: t?.subagents ?? [], messages: [...page.messages.filter((m) => !have.has(m.id)), ...(t?.messages ?? [])] };
          });
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    setOlderState((was) => (was.key === asked ? { key: asked, busy: false, error } : was));
  };

  /** The task as a request about it returned (a message sent, say): taken only while it's still the thread shown, since
   *  `detail` outlives a switch to another, and a send made before the switch can finish after it. */
  const settled = (t: Task) => {
    if (t.id === current.current.split("/").pop()) detail.setData(t);
  };

  return { detail, thread, delta, shown, older, olderBusy, olderError, task: detail.data, settled };
}

export type Thread = ReturnType<typeof useThread>;

/** The thread's messages, newest at the bottom. */
export function ThreadMessages({
  t,
  client,
  host,
  taskId,
  emptyTitle,
  onOpenTask,
}: {
  t: Thread;
  client: Client;
  host: string;
  taskId: string;
  emptyTitle?: string;
  /** Opens another task on this host: a report's routine thread. */
  onOpenTask?: (id: string) => void;
}) {
  const { thread, delta, shown, task } = t;
  return (
    <>
      {/* Outside the inverted list, which would draw it upside down. */}
      {!thread.loading && !shown.length && !delta && <Empty title={task?.running ? "The agent is starting…" : (emptyTitle ?? "No messages yet.")} />}
      <FlatList
        inverted
        data={shown}
        keyExtractor={(it) => it.key}
        contentContainerStyle={{ paddingVertical: 8 }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          delta ? (
            <View style={[s.card, { borderColor: colors.accent }]}>
              <Markdown text={delta} />
            </View>
          ) : task?.running ? (
            <Text style={[s.faint, { padding: 12 }]}>The agent is working…</Text>
          ) : undefined
        }
        ListFooterComponent={
          thread.data?.more ? <Button title="Earlier messages" small kind="ghost" busy={t.olderBusy} onPress={t.older} style={{ margin: 12 }} /> : undefined
        }
        renderItem={({ item }) => <Row item={item} client={client} host={host} taskId={taskId} onAnswered={() => thread.reload()} onOpenTask={onOpenTask} />}
      />
    </>
  );
}

function Row({
  item,
  client,
  host,
  taskId,
  onAnswered,
  onOpenTask,
}: {
  item: ThreadItem;
  client: Client;
  host: string;
  taskId: string;
  onAnswered: () => void;
  onOpenTask?: (id: string) => void;
}) {
  switch (item.type) {
    case "user":
      return (
        <View
          style={{
            alignSelf: "flex-end",
            maxWidth: "85%",
            margin: 6,
            marginHorizontal: 12,
            padding: 10,
            borderRadius: 12,
            backgroundColor: "rgba(109,90,230,0.35)",
          }}
        >
          <Text style={{ color: colors.fg, fontSize: 15 }} selectable>
            {item.text}
          </Text>
        </View>
      );
    case "text":
      return (
        <View style={{ paddingHorizontal: 14, paddingVertical: 6 }}>
          <Markdown text={item.text} />
        </View>
      );
    case "tool":
      return (
        <Text style={[s.faint, { paddingHorizontal: 14, paddingVertical: 2 }]} numberOfLines={2}>
          <Text style={{ color: item.failed ? colors.red : item.done ? colors.muted : colors.blue, fontWeight: "600" }}>{item.name}</Text>{" "}
          {toolSummary(item.input)}
        </Text>
      );
    case "event":
      return (
        <Text style={[s.faint, { paddingHorizontal: 14, paddingVertical: 4, color: item.level === "error" ? colors.red : colors.faint }]}>{item.text}</Text>
      );
    case "result":
      return <ErrorText>{item.text}</ErrorText>;
    case "permission":
      return item.status === "pending" && item.requestId ? (
        <View style={[s.card, { borderColor: colors.amber }]}>
          <PermissionCard client={client} hostId={host} id={item.requestId} tool={item.tool} input={item.input} onDone={onAnswered} />
        </View>
      ) : (
        <Text style={[s.faint, { paddingHorizontal: 14, paddingVertical: 2 }]} numberOfLines={1}>
          {item.tool} · {item.status || "answered"}
        </Text>
      );
    case "report":
      return <ReportCard item={item} onOpenTask={onOpenTask} />;
    case "question":
      return item.data?.status === "pending" ? (
        <View style={[s.card, { borderColor: colors.accent }]}>
          <QuestionCard client={client} hostId={host} taskId={taskId} messageId={item.id} data={item.data} onDone={onAnswered} />
        </View>
      ) : (
        <View style={[s.card, { opacity: 0.7 }]}>
          <Text style={s.muted}>{String(item.data?.question ?? "")}</Text>
        </View>
      );
  }
}

/** How a routine's run ended, as the report's header says it. */
export const REPORT_OUTCOME: Record<string, string> = { reported: "reported", asked: "asks you", failed: "failed", stopped: "was stopped" };

/** A routine's report: its name and how its run ended, its text, and a link to the routine's thread. */
function ReportCard({ item, onOpenTask }: { item: Extract<ThreadItem, { type: "report" }>; onOpenTask?: (id: string) => void }) {
  const bad = item.outcome === "failed" || item.outcome === "stopped";
  const id = item.taskId;
  const open = onOpenTask && id ? () => onOpenTask(id) : undefined;
  return (
    <View style={[s.card, { borderColor: bad ? colors.red : item.outcome === "asked" ? colors.amber : colors.line }]}>
      <Text style={[s.muted, { marginBottom: 4 }]}>
        <Text style={{ color: colors.fg, fontWeight: "600" }}>{item.automation}</Text> {REPORT_OUTCOME[item.outcome] ?? item.outcome}
      </Text>
      {!!item.text && <Markdown text={item.text} />}
      {open && (
        <Pressable onPress={open} accessibilityRole="link" style={{ marginTop: 6 }}>
          <Text style={{ color: colors.accent }}>Open {item.taskKey ?? "its thread"}</Text>
        </Pressable>
      )}
    </View>
  );
}
