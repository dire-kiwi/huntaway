// The Assistant, the app's home tab: the selected board's assistant for its picked profile, with the composer (and
// whatever was shared into the app, filled in). It's on the host the profile's assistant is on (an assistant host of its
// own, perhaps), and says so when that host is offline. A board older than API 116 has no tab: the Inbox is home then.
import type { Client, Task } from "@huntaway/client";
import { Redirect, Tabs, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useRef } from "react";
import { KeyboardAvoidingView, Platform, Text, View } from "react-native";
import { homeOf, openAssistant, showsAssistant, stillOpen, unavailableNote, type Opened } from "../../assistant";
import { BoardPicker } from "../../boardPicker";
import { loadProfiles, pickedProfile, profilesOf } from "../../boardData";
import type { Board } from "../../boards";
import { Composer, type Prefill } from "../../composer";
import { boards, clientFor, statusOf, useBoards, useBoardStatuses, useLoad, useRefetchOn } from "../../session";
import { shares, usePendingShare } from "../../share";
import { WaitingShare } from "../../shareCard";
import { ThreadMessages, useThread } from "../../threadView";
import { colors } from "../../theme";
import { Button, Empty, ErrorText, s } from "../../ui";

export default function AssistantTab() {
  useBoards();
  const statuses = useBoardStatuses();
  const board = boards.selectedBoard();
  if (!board || !showsAssistant(board, statusOf(statuses, board.id))) return <Redirect href="/inbox" />;
  // Another board's starts from nothing.
  return <Assistant key={board.id} board={board} />;
}

function Assistant({ board }: { board: Board }) {
  const client = clientFor(board);
  const headerHeight = useHeaderHeight();
  const statuses = useBoardStatuses();

  const loaded = useLoad(() => loadProfiles(client, board.id), [board.id, board.url]);
  const profiles = profilesOf(board, loaded.data);
  const profile = pickedProfile(board, profiles);
  const home = profiles && profile ? homeOf(profiles, profile) : undefined;
  const hostName = home ? (profiles?.allHosts.find((h) => h.id === home.hostId)?.name ?? home.hostId) : "";
  // Kept while its host is offline for a while, so the thread and what's typed stay.
  const opened = useRef<Opened | undefined>(undefined);
  opened.current = stillOpen(opened.current, profile, home);
  const open = opened.current?.home;
  const assistant = useLoad(async () => (open ? openAssistant(client, open) : undefined), [board.id, open?.hostId, open?.profileId]);
  // A host coming back (or going), or the profile's assistant host changed: where it is may have changed.
  useRefetchOn((b, ev) => b === board.id && ["profiles_changed", "hosts_changed", "resync"].includes(ev.type), loaded.reload);

  const task = assistant.data;
  const pending = usePendingShare();
  const prefill = pending && pending.boardId === board.id && task ? { id: pending.id, ...pending.draft } : null;

  const retry = () => (loaded.reload(), assistant.reload());
  const note = (() => {
    if (loaded.error) return loaded.error;
    if (!profiles) return null;
    if (!profile) return `${board.name} has no profiles yet.`;
    if (!home) return `No host on ${board.name} has an assistant for ${profile}.`;
    if (home.unavailable) return unavailableNote(profile, hostName, home.unavailable);
    return null;
  })();

  return (
    <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={headerHeight}>
      <Tabs.Screen options={{ title: profile && profiles && profiles.names.length > 1 ? `${profile}'s assistant` : "Assistant" }} />
      <BoardPicker board={board} profiles={profiles} profile={profile} only={(b) => showsAssistant(b, statusOf(statuses, b.id))} />
      {!assistant.loading && <WaitingShare pending={pending} board={board} boardName={(id) => boards.board(id)?.name} taking={!!prefill} />}
      {note && task && (
        <View style={[s.card, { borderColor: colors.amber }]}>
          <Text style={s.muted}>{note}</Text>
        </View>
      )}
      {note && !task ? (
        <Empty title={note}>
          <Button title="Try again" small onPress={retry} />
        </Empty>
      ) : assistant.error && !task ? (
        <Empty title={`Couldn't open ${profile}'s assistant on ${hostName}: ${assistant.error}`}>
          <Button title="Try again" small onPress={retry} />
        </Empty>
      ) : task ? (
        // One assistant's thread, its composer (and the sends under way from it), its earlier pages and its Stop: another
        // assistant's (another profile's, or the same one's on another host) mounts afresh, so nothing late from this one
        // can land there.
        <AssistantThread
          key={`${board.id}/${task.host_id}/${task.id}`}
          board={board}
          client={client}
          task={task}
          profile={profile ?? ""}
          prefill={prefill}
        />
      ) : (
        <View style={{ flex: 1 }} />
      )}
    </KeyboardAvoidingView>
  );
}

function AssistantThread({ board, client, task, profile, prefill }: { board: Board; client: Client; task: Task; profile: string; prefill: Prefill | null }) {
  const host = task.host_id;
  const t = useThread(board.id, client, host, task.id);
  const router = useRouter();
  const openTask = (id: string) => router.push({ pathname: "/task/[board]/[host]/[id]", params: { board: board.id, host, id } });
  const shown = t.task ?? task;
  return (
    <>
      {shown.running && (
        <View style={[s.row, { paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.line }]}>
          <Text style={[s.faint, { color: colors.blue, flex: 1 }]}>The assistant is working</Text>
          <Button title="Stop" small kind="danger" onPress={() => void client.stop(host, shown.id).catch(() => {})} />
        </View>
      )}
      {(t.thread.error || t.detail.error || t.olderError) && (
        <View style={{ padding: 12 }}>
          <ErrorText>{t.thread.error ?? t.detail.error ?? t.olderError}</ErrorText>
        </View>
      )}
      <ThreadMessages t={t} client={client} host={host} taskId={task.id} onOpenTask={openTask} emptyTitle={`Ask ${profile}'s assistant anything: it remembers you, and works outside every project.`} />
      <Composer
        client={client}
        host={host}
        taskId={task.id}
        bottom={0}
        placeholder="Ask your assistant"
        onSent={t.settled}
        prefill={prefill}
        onPrefilled={(id) => shares.clear(id)}
      />
    </>
  );
}
