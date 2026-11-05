// The Inbox: what's waiting for you on every paired board together, newest first, each labelled with its board.
// Prompts and questions are answered in place; a task that needs attention opens its thread.
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { loadBoardInbox, mergeInbox, type InboxItem } from "../../inbox";
import { isQuestionTool, PermissionCard, QuestionCard } from "../../prompts";
import { boards, clientFor, statusOf, usable, useBoards, useBoardStatuses, useLoad, useRefetchOn } from "../../session";
import { colors } from "../../theme";
import { BoardLabel, Button, Empty, ErrorText, s } from "../../ui";

/** Events that can change what's waiting: a task's status, a prompt or question asked or answered, a reconnect. */
const relevant = (ev: { type: string; message?: { kind?: string } }) =>
  ev.type === "task" || ev.type === "task_deleted" || ev.type === "resync" || ev.type === "profiles_changed" || ev.type === "hosts_changed" ||
  ((ev.type === "message" || ev.type === "message_updated") && ["permission", "question", "user"].includes(ev.message?.kind ?? ""));

export default function Inbox() {
  const router = useRouter();
  const { boards: list } = useBoards();
  const statuses = useBoardStatuses();
  const live = list.filter((b) => usable(statusOf(statuses, b.id)));
  const key = live.map((b) => `${b.id}:${b.profile}:${b.url}`).join(",");
  const inbox = useLoad(async () => mergeInbox(await Promise.all(live.map((b) => loadBoardInbox(clientFor(b), b, b.profile)))), [key]);
  useRefetchOn((_, ev) => relevant(ev), inbox.reload);
  // Answered here: gone at once, before the board's events say so.
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const done = useCallback((k: string) => {
    setAnswered((a) => new Set(a).add(k));
    inbox.reload();
  }, [inbox]);

  if (!list.length) {
    return (
      <View style={s.screen}>
        <Empty title="Pair the app with a board to see what's waiting for you there.">
          <Button title="Pair a board" kind="primary" onPress={() => router.push("/pair")} />
        </Empty>
      </View>
    );
  }
  const items = (inbox.data?.items ?? []).filter((i) => !answered.has(i.key));
  const open = (i: InboxItem) => router.push({ pathname: "/task/[board]/[host]/[id]", params: { board: i.board.id, host: i.hostId, id: i.taskId } });

  return (
    <View style={s.screen}>
      <FlatList
        data={items}
        keyExtractor={(i) => i.key}
        refreshControl={<RefreshControl refreshing={inbox.loading && !!inbox.data} onRefresh={inbox.reload} tintColor={colors.accent} />}
        ListHeaderComponent={
          <View style={{ paddingTop: 6 }}>
            {list
              .filter((b) => !usable(statusOf(statuses, b.id)))
              .map((b) => (
                <Pressable key={b.id} onPress={() => router.push("/boards")} style={[s.card, { borderColor: colors.amber }]}>
                  <BoardLabel name={b.name} />
                  <Text style={s.muted}>
                    {statusOf(statuses, b.id).unauthorized ? "This phone was unpaired from this board. Pair it again." : "This board's Huntaway is too old for the app. Update it."}
                  </Text>
                </Pressable>
              ))}
            {inbox.data?.errors.map((e) => (
              <View key={e.board.id} style={s.card}>
                <BoardLabel name={e.board.name} />
                <ErrorText>Couldn't read it: {e.error}</ErrorText>
              </View>
            ))}
          </View>
        }
        ListEmptyComponent={inbox.loading ? undefined : <Empty title="Nothing's waiting for you." />}
        renderItem={({ item }) => {
          const client = clientFor(boards.board(item.board.id) ?? { id: item.board.id, url: "" });
          return (
            <View style={s.card}>
              <Pressable onPress={() => open(item)} accessibilityRole="link" style={{ gap: 4 }}>
                <View style={s.row}>
                  <BoardLabel name={item.board.name} />
                  {!!item.taskKey && <Text style={s.faint}>{item.taskKey}</Text>}
                  <Text style={[s.faint, { marginLeft: "auto", color: item.kind === "attention" ? colors.amber : colors.accent }]}>
                    {item.kind === "permission" ? (isQuestionTool(item.permission.tool_name) ? "Question" : "Permission") : item.kind === "question" ? "Question" : "Needs attention"}
                  </Text>
                </View>
                <Text style={s.title} numberOfLines={2}>
                  {item.title}
                </Text>
              </Pressable>
              {item.kind === "permission" && (
                <PermissionCard
                  client={client}
                  hostId={item.hostId}
                  id={item.permission.id}
                  tool={item.permission.tool_name}
                  input={item.permission.input}
                  onDone={() => done(item.key)}
                />
              )}
              {item.kind === "question" && (
                <QuestionCard client={client} hostId={item.hostId} taskId={item.taskId} messageId={item.message.id} data={item.message.data} onDone={() => done(item.key)} />
              )}
              {item.kind === "attention" && !!item.reason && (
                <Text style={s.muted} numberOfLines={4}>
                  {item.reason}
                </Text>
              )}
            </View>
          );
        }}
      />
    </View>
  );
}
