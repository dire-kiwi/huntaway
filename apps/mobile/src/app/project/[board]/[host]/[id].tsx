// A project's tasks, grouped by status as the board's columns are, kept current by the board's task events; and a
// sheet to add a task (and start its agent).
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, SectionList, Switch, Text, TextInput, View } from "react-native";
import { boards, clientFor, useBoardEvents, useBoards, useLoad, useRefetchOn } from "../../../../session";
import { groupTasks, upsert } from "../../../../tasks";
import { colors, STATUS_COLOR } from "../../../../theme";
import { Button, Empty, ErrorText, s, Section } from "../../../../ui";

export default function ProjectScreen() {
  const { board: boardId, host, id, name } = useLocalSearchParams<{ board: string; host: string; id: string; name?: string }>();
  const router = useRouter();
  useBoards();
  const board = boards.board(boardId);
  const client = board && clientFor(board);
  const project = useLoad(async () => (client ? client.getProject(host, id) : undefined), [boardId, host, id]);
  const tasks = useLoad(async () => (client ? client.projectTasks(host, id) : []), [boardId, host, id]);
  const [adding, setAdding] = useState(false);

  // Task changes as they happen; a reconnect reads them all again.
  useBoardEvents((b, ev) => {
    if (b !== boardId || ev.host_id !== host) return;
    if (ev.type === "task" && ev.task?.project_id === id) {
      tasks.setData((list = []) => upsert(list, ev.task));
    } else if (ev.type === "task_deleted") tasks.setData((list = []) => list.filter((t) => t.id !== ev.id));
  });
  useRefetchOn((b, ev) => b === boardId && ev.type === "resync", tasks.reload);

  const sections = useMemo(() => groupTasks(tasks.data ?? []), [tasks.data]);
  const title = project.data?.name ?? name ?? "Project";
  if (!board) return <Empty title="This board isn't paired any more." />;

  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{ title, headerRight: () => <Button title="New task" small kind="primary" onPress={() => setAdding(true)} style={{ marginRight: 8 }} /> }}
      />
      <SectionList
        sections={sections}
        keyExtractor={(t) => t.id}
        refreshControl={<RefreshControl refreshing={tasks.loading && !!tasks.data} onRefresh={tasks.reload} tintColor={colors.accent} />}
        ListHeaderComponent={tasks.error ? <ErrorText>{tasks.error}</ErrorText> : undefined}
        ListEmptyComponent={tasks.loading ? undefined : <Empty title="No tasks yet." />}
        renderSectionHeader={({ section }) => <Section title={`${section.title} · ${section.data.length}`} />}
        stickySectionHeadersEnabled={false}
        renderItem={({ item: t }) => (
          <Pressable
            style={s.card}
            accessibilityRole="link"
            onPress={() => router.push({ pathname: "/task/[board]/[host]/[id]", params: { board: boardId, host, id: t.id } })}
          >
            <View style={s.row}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: STATUS_COLOR[t.status] }} />
              <Text style={s.faint}>{project.data ? `${project.data.key}-${t.number}` : `#${t.number}`}</Text>
              {t.running && <Text style={[s.faint, { color: colors.blue }]}>running</Text>}
            </View>
            <Text style={s.title} numberOfLines={2}>
              {t.title}
            </Text>
            {t.status === "needs_attention" && !!t.attention_reason && (
              <Text style={s.muted} numberOfLines={2}>
                {t.attention_reason}
              </Text>
            )}
          </Pressable>
        )}
      />
      {adding && client && (
        <NewTask
          onClose={() => setAdding(false)}
          create={async (b) => {
            const t = await client.createTask(host, id, { ...b, status: b.start ? "in_progress" : "todo" });
            tasks.setData((list = []) => upsert(list, t));
            setAdding(false);
            router.push({ pathname: "/task/[board]/[host]/[id]", params: { board: boardId, host, id: t.id } });
          }}
        />
      )}
    </View>
  );
}

function NewTask({ onClose, create }: { onClose: () => void; create: (b: { title?: string; description: string; start: boolean }) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      // With no title, the board writes one from the description.
      await create({ title: title.trim() || undefined, description: description.trim(), start });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" }}
      >
        <View style={{ backgroundColor: colors.panel, padding: 16, gap: 12, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 32 }}>
          <Text style={[s.title, { fontSize: 17 }]}>New task</Text>
          <TextInput style={s.input} value={title} onChangeText={setTitle} placeholder="Title (optional)" placeholderTextColor={colors.faint} />
          <TextInput
            style={[s.input, { minHeight: 120, textAlignVertical: "top", paddingTop: 10 }]}
            value={description}
            onChangeText={setDescription}
            placeholder="What should the agent do?"
            placeholderTextColor={colors.faint}
            multiline
            autoFocus
          />
          <View style={s.row}>
            <Switch value={start} onValueChange={setStart} trackColor={{ true: colors.accentStrong }} />
            <Text style={s.muted}>Start its agent now</Text>
          </View>
          {err && <ErrorText>{err}</ErrorText>}
          <View style={[s.row, { justifyContent: "flex-end" }]}>
            <Button title="Cancel" kind="ghost" onPress={onClose} />
            <Button title={start ? "Create and start" : "Create"} kind="primary" busy={busy} disabled={!title.trim() && !description.trim()} onPress={submit} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
