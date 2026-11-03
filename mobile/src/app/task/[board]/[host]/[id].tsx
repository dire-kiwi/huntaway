// A task's thread: its messages (the agent's as markdown, with its reply streaming in), the prompts and questions it
// waits on, and the composer, with photos from the camera or library as attachments. Start, stop and move are in the
// header. Diffs, commits and the terminal are on the web board.
import { STATUSES, type Attachment, type Message, type Status, type Task } from "@huntaway/client";
import * as ImagePicker from "expo-image-picker";
import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { photoName, withAttachments } from "../../../../attachments";
import { Markdown } from "../../../../markdown";
import { PermissionCard, QuestionCard, toolSummary } from "../../../../prompts";
import { boards, clientFor, useBoardEvents, useBoards, useLoad } from "../../../../session";
import { colors, STATUS_COLOR } from "../../../../theme";
import { applyDelta, endsDelta, hiddenUser, threadItems, withMessage, type ThreadItem } from "../../../../thread";
import { Button, Empty, ErrorText, s } from "../../../../ui";

const PAGE = 60;

export default function TaskScreen() {
  const { board: boardId, host, id } = useLocalSearchParams<{ board: string; host: string; id: string }>();
  useBoards();
  const board = boards.board(boardId);
  const client = board && clientFor(board);
  const insets = useSafeAreaInsets();

  const detail = useLoad(async () => (client ? (await client.task(host, id)).task : undefined), [boardId, host, id]);
  const thread = useLoad(async () => (client ? client.messagePage(host, id, { limit: PAGE }) : { messages: [] as Message[], more: false, subagents: [] }), [boardId, host, id]);
  const [delta, setDelta] = useState("");
  const [moving, setMoving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const task = detail.data;

  useBoardEvents((b, ev) => {
    if (b !== boardId) return;
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

  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const older = async () => {
    const first = thread.data?.messages[0];
    if (!client || !first) return;
    setOlderBusy(true);
    await act(async () => {
      const page = await client.messagePage(host, id, { before: first.id, limit: PAGE });
      thread.setData((t) => ({ more: page.more, subagents: t?.subagents ?? [], messages: [...page.messages, ...(t?.messages ?? [])] }));
    });
    setOlderBusy(false);
  };

  if (!board || !client) return <Empty title="This board isn't paired any more." />;

  const start = () =>
    act(async () => {
      if (task && (task.status === "todo" || task.status === "backlog")) detail.setData(await client.updateTask(host, id, { status: "in_progress" }));
      // Moving it doesn't start the agent: an empty message does, as the board's own start does.
      detail.setData(await client.send(host, id, ""));
    });
  const stop = () => act(() => client.stop(host, id));
  const move = (status: Status) =>
    act(async () => {
      setMoving(false);
      detail.setData(await client.updateTask(host, id, { status }));
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
      {(err || thread.error || detail.error) && (
        <View style={{ padding: 12 }}>
          <ErrorText>{err ?? thread.error ?? detail.error}</ErrorText>
        </View>
      )}
      {/* Outside the inverted list, which would draw it upside down. */}
      {!thread.loading && !shown.length && !delta && <Empty title={task?.running ? "The agent is starting…" : "No messages yet."} />}
      <FlatList
        inverted
        data={shown}
        keyExtractor={(it) => it.key}
        contentContainerStyle={{ paddingVertical: 8 }}
        ListHeaderComponent={
          delta ? (
            <View style={[s.card, { borderColor: colors.accent }]}>
              <Markdown text={delta} />
            </View>
          ) : task?.running ? (
            <Text style={[s.faint, { padding: 12 }]}>The agent is working…</Text>
          ) : undefined
        }
        ListFooterComponent={thread.data?.more ? <Button title="Earlier messages" small kind="ghost" busy={olderBusy} onPress={older} style={{ margin: 12 }} /> : undefined}
        renderItem={({ item }) => <Row item={item} client={client} host={host} taskId={id} onAnswered={() => thread.reload()} />}
      />
      <Composer client={client} host={host} taskId={id} bottom={insets.bottom} onSent={(t) => detail.setData(t)} />
      <Modal visible={moving} transparent animationType="fade" onRequestClose={() => setMoving(false)}>
        <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }} onPress={() => setMoving(false)}>
          <View style={{ backgroundColor: colors.panel, padding: 12, paddingBottom: 32, gap: 4, borderTopLeftRadius: 16, borderTopRightRadius: 16 }}>
            <Text style={[s.title, { padding: 8 }]}>Move to</Text>
            {STATUSES.map((st) => (
              <Pressable key={st.id} accessibilityRole="button" onPress={() => move(st.id)} style={[s.row, { padding: 12, borderRadius: 8, backgroundColor: st.id === task?.status ? colors.raised : undefined }]}>
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

function Row({ item, client, host, taskId, onAnswered }: { item: ThreadItem; client: ReturnType<typeof clientFor>; host: string; taskId: string; onAnswered: () => void }) {
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

function Composer({ client, host, taskId, bottom, onSent }: { client: ReturnType<typeof clientFor>; host: string; taskId: string; bottom: number; onSent: (t: Task) => void }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState<"send" | "photo" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const addPhoto = async (from: "camera" | "library") => {
    setErr(null);
    const perm = from === "camera" ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setErr(from === "camera" ? "Camera access is off for Huntaway: allow it in Settings." : "Photo access is off for Huntaway: allow it in Settings.");
      return;
    }
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], base64: true, quality: 0.7, allowsMultipleSelection: from === "library", selectionLimit: 5 };
    const picked = from === "camera" ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (picked.canceled) return;
    setBusy("photo");
    try {
      for (const a of picked.assets) {
        if (!a.base64) continue;
        const att = await client.uploadAttachment(host, photoName(a.fileName, a.mimeType), a.base64);
        setFiles((f) => [...f, att]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    setBusy("send");
    setErr(null);
    try {
      onSent(await client.send(host, taskId, withAttachments(text, files)));
      setText("");
      setFiles([]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.panel, padding: 8, paddingBottom: 8 + bottom, gap: 6 }}>
      {files.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {files.map((f) => (
            <Pressable key={f.id} onPress={() => setFiles((x) => x.filter((y) => y.id !== f.id))} accessibilityLabel={`Remove ${f.name}`} style={[s.chip, { height: 28 }]}>
              <Text style={s.faint}>📎 {f.name} ✕</Text>
            </Pressable>
          ))}
        </View>
      )}
      {err && <ErrorText>{err}</ErrorText>}
      <View style={[s.row, { alignItems: "flex-end" }]}>
        <Button title="📷" small kind="ghost" busy={busy === "photo"} onPress={() => addPhoto("camera")} />
        <Button title="🖼" small kind="ghost" disabled={busy === "photo"} onPress={() => addPhoto("library")} />
        <TextInput
          style={[s.input, { flex: 1, maxHeight: 140, paddingTop: 10 }]}
          value={text}
          onChangeText={setText}
          placeholder="Message the agent"
          placeholderTextColor={colors.faint}
          multiline
          accessibilityLabel="Message"
        />
        <Button title="Send" small kind="primary" busy={busy === "send"} disabled={!text.trim() && !files.length} onPress={send} />
      </View>
    </View>
  );
}
