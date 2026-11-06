// A task's thread: its messages (the agent's as markdown, with its reply streaming in), the prompts and questions it
// waits on, and the composer, with photos from the camera or library as attachments. Start, stop and move are in the
// header. Diffs, commits and the terminal are on the web board.
import { moveTask, STATUSES, type Status } from "@huntaway/client";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Linking, Modal, Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Composer } from "../../../../composer";
import { boards, clientFor, useBoards } from "../../../../session";
import { colors, STATUS_COLOR } from "../../../../theme";
import { ThreadMessages, useThread } from "../../../../threadView";
import { Button, Empty, ErrorText, s } from "../../../../ui";

export default function TaskScreen() {
  const { board: boardId, host, id } = useLocalSearchParams<{ board: string; host: string; id: string }>();
  useBoards();
  const board = boards.board(boardId);
  const client = board && clientFor(board);
  const insets = useSafeAreaInsets();

  const t = useThread(boardId, client, host, id);
  const router = useRouter();
  const { detail, thread, task } = t;
  const [moving, setMoving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (!board || !client) return <Empty title="This board isn't paired any more." />;

  const start = () =>
    act(async () => {
      if (task && (task.status === "todo" || task.status === "backlog")) detail.setData(await client.updateTask(host, id, { status: "in_progress" }));
      // Moving it doesn't start the agent: an empty message does, as the board's own start does.
      detail.setData(await client.send(host, id, ""));
    });
  const stop = () => act(() => client.stop(host, id));
  // As the web board's move: a fresh task moved into In progress starts its agent.
  const move = (status: Status) =>
    act(async () => {
      setMoving(false);
      if (!task) return;
      const on = (await client.hosts()).find((h) => h.id === host);
      detail.setData(await moveTask(client, task, status, on));
    });

  const headerRight = () =>
    task ? (
      <View style={[s.row, { marginRight: 8 }]}>
        {task.running ? (
          <Button title="Stop" small kind="danger" onPress={stop} />
        ) : task.status === "todo" || task.status === "backlog" ? (
          <Button title="Start" small kind="primary" onPress={start} />
        ) : null}
        <Button title="Move" small onPress={() => setMoving(true)} />
      </View>
    ) : null;

  return (
    <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}>
      <Stack.Screen options={{ title: task?.title ?? "Task", headerRight }} />
      {task && (
        <View style={[s.row, { paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.line }]}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: STATUS_COLOR[task.status] }} />
          <Text style={s.muted}>{STATUSES.find((x) => x.id === task.status)?.label}</Text>
          {task.running && <Text style={[s.faint, { color: colors.blue }]}>· agent running</Text>}
          {task.pr_url && (
            <Text style={[s.faint, { color: colors.accent, marginLeft: "auto" }]} onPress={() => void Linking.openURL(task.pr_url!)}>
              Pull request
            </Text>
          )}
        </View>
      )}
      {(err || thread.error || detail.error || t.olderError) && (
        <View style={{ padding: 12 }}>
          <ErrorText>{err ?? thread.error ?? detail.error ?? t.olderError}</ErrorText>
        </View>
      )}
      <ThreadMessages
        t={t}
        client={client}
        host={host}
        onOpenTask={(task) => router.push({ pathname: "/task/[board]/[host]/[id]", params: { board: boardId, host, id: task } })}
        taskId={id}
      />
      <Composer client={client} host={host} taskId={id} bottom={insets.bottom} onSent={t.settled} />
      <Modal visible={moving} transparent animationType="fade" onRequestClose={() => setMoving(false)}>
        <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }} onPress={() => setMoving(false)}>
          <View style={{ backgroundColor: colors.panel, padding: 12, paddingBottom: 32, gap: 4, borderTopLeftRadius: 16, borderTopRightRadius: 16 }}>
            <Text style={[s.title, { padding: 8 }]}>Move to</Text>
            {STATUSES.map((st) => (
              <Pressable
                key={st.id}
                accessibilityRole="button"
                onPress={() => move(st.id)}
                style={[s.row, { padding: 12, borderRadius: 8, backgroundColor: st.id === task?.status ? colors.raised : undefined }]}
              >
                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: STATUS_COLOR[st.id] }} />
                <Text style={{ color: colors.fg, fontSize: 16 }}>{st.label}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}
