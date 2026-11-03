// A thread on the phone, as the task screen and the Assistant tab show it: its messages (the agent's as markdown, with
// its reply streaming in), the prompts and questions it waits on, kept current from the board's events, with earlier
// pages on request.
import type { Client, Message, Task } from "@huntaway/client";
import { useMemo, useState } from "react";
import { FlatList, Text, View } from "react-native";
import { Markdown } from "./markdown";
import { PermissionCard, QuestionCard, toolSummary } from "./prompts";
import { useBoardEvents, useLoad } from "./session";
import { colors } from "./theme";
import { applyDelta, endsDelta, hiddenUser, threadItems, withMessage, type ThreadItem } from "./thread";
import { Button, Empty, ErrorText, s } from "./ui";

const PAGE = 60;

/** Task `id` on host `host` of board `boardId`, and its thread, kept current. */
export function useThread(boardId: string, client: Client | undefined, host: string, id: string) {
  const detail = useLoad(async () => (client && id ? (await client.task(host, id)).task : undefined), [boardId, host, id]);
  const thread = useLoad(
    async () => (client && id ? client.messagePage(host, id, { limit: PAGE }) : { messages: [] as Message[], more: false, subagents: [] }),
    [boardId, host, id],
  );
  const [delta, setDelta] = useState("");
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);

  useBoardEvents((b, ev) => {
    if (b !== boardId || !id) return;
    if (ev.type === "resync") {
      detail.reload();
      thread.reload();
      return;
    }
    if (ev.host_id !== host) return;
    if (ev.type === "task" && ev.task?.id === id) detail.setData(ev.task as Task);
    else if ((ev.type === "message" || ev.type === "message_updated") && ev.task_id === id) {
      const m = ev.message as Message;
      if (endsDelta(m)) setDelta("");
      thread.setData((t) => ({ more: t?.more ?? false, subagents: t?.subagents ?? [], messages: withMessage(t?.messages ?? [], m) }));
    } else if ((ev.type === "delta" || ev.type === "delta_reset") && ev.task_id === id) setDelta((d) => applyDelta(d, ev));
  });

  const items = useMemo(() => threadItems(thread.data?.messages ?? []).filter((it) => !hiddenUser(it)), [thread.data]);
  // Newest first, for the inverted list.
  const shown = useMemo(() => [...items].reverse(), [items]);

  const older = async () => {
    const first = thread.data?.messages[0];
    if (!client || !first) return;
    setOlderBusy(true);
    setOlderError(null);
    try {
      const page = await client.messagePage(host, id, { before: first.id, limit: PAGE });
      thread.setData((t) => ({ more: page.more, subagents: t?.subagents ?? [], messages: [...page.messages, ...(t?.messages ?? [])] }));
    } catch (e) {
      setOlderError(e instanceof Error ? e.message : String(e));
    }
    setOlderBusy(false);
  };

  return { detail, thread, delta, shown, older, olderBusy, olderError, task: detail.data };
}

export type Thread = ReturnType<typeof useThread>;

/** The thread's messages, newest at the bottom. */
export function ThreadMessages({ t, client, host, taskId, emptyTitle }: { t: Thread; client: Client; host: string; taskId: string; emptyTitle?: string }) {
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
        ListFooterComponent={thread.data?.more ? <Button title="Earlier messages" small kind="ghost" busy={t.olderBusy} onPress={t.older} style={{ margin: 12 }} /> : undefined}
        renderItem={({ item }) => <Row item={item} client={client} host={host} taskId={taskId} onAnswered={() => thread.reload()} />}
      />
    </>
  );
}

function Row({ item, client, host, taskId, onAnswered }: { item: ThreadItem; client: Client; host: string; taskId: string; onAnswered: () => void }) {
  switch (item.type) {
    case "user":
      return (
        <View style={{ alignSelf: "flex-end", maxWidth: "85%", margin: 6, marginHorizontal: 12, padding: 10, borderRadius: 12, backgroundColor: "rgba(109,90,230,0.35)" }}>
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
          <Text style={{ color: item.failed ? colors.red : item.done ? colors.muted : colors.blue, fontWeight: "600" }}>{item.name}</Text> {toolSummary(item.input)}
        </Text>
      );
    case "event":
      return <Text style={[s.faint, { paddingHorizontal: 14, paddingVertical: 4, color: item.level === "error" ? colors.red : colors.faint }]}>{item.text}</Text>;
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
