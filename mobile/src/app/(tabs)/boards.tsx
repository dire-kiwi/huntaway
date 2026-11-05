// Boards: the paired boards, each with its status and the profile picked on it; pair another, open one on the web
// (for what the app leaves out: terminals, diffs, settings, analytics) or remove one, which unpairs the phone there.
import type { Board } from "../../boards";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Linking, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { loadProfiles, pickedProfile, profilesOf } from "../../boardData";
import { boards, clientFor, statusOf, usable, useBoards, useBoardStatuses, useLoad, type BoardStatus } from "../../session";
import { colors } from "../../theme";
import { Button, Chip, s } from "../../ui";

function statusText(st: BoardStatus) {
  if (st.unauthorized) return { text: "Unpaired: pair it again", color: colors.red };
  if (st.tooOld) return { text: "Too old for the app: update its Huntaway", color: colors.amber };
  return st.connected ? { text: "Live", color: colors.green } : { text: "Connecting…", color: colors.faint };
}

function confirm(title: string, message: string, action: string): Promise<boolean> {
  if (Platform.OS === "web") return Promise.resolve(globalThis.confirm?.(`${title}\n\n${message}`) ?? true);
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: action, style: "destructive", onPress: () => resolve(true) },
    ]),
  );
}

function BoardCard({ board, status, selected }: { board: Board; status: BoardStatus; selected: boolean }) {
  const router = useRouter();
  const ok = usable(status);
  const loaded = useLoad(async () => (ok ? loadProfiles(clientFor(board), board.id) : undefined), [board.id, board.url, ok]);
  const profiles = { ...loaded, data: profilesOf(board, loaded.data) };
  const profile = pickedProfile(board, profiles.data);
  const [busy, setBusy] = useState(false);
  const st = statusText(status);

  const remove = async () => {
    if (!(await confirm(`Remove ${board.name}?`, "The app forgets it, and this phone is unpaired from it.", "Remove"))) return;
    setBusy(true);
    // Unpairs itself on the board too, if it can reach it.
    if (board.deviceId && !status.unauthorized) await clientFor(board).revokeDevice(board.deviceId).catch(() => {});
    await boards.remove(board.id);
    setBusy(false);
  };

  return (
    <Pressable style={[s.card, selected && { borderColor: colors.accent }]} onPress={() => void boards.select(board.id)} accessibilityLabel={`Board ${board.name}`}>
      <View style={s.row}>
        <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: st.color }} />
        <Text style={[s.title, { flex: 1 }]} numberOfLines={1}>
          {board.name}
        </Text>
        {selected && <Text style={[s.faint, { color: colors.accent }]}>Selected</Text>}
      </View>
      <Text style={s.faint} selectable>
        {board.url}
      </Text>
      <Text style={[s.faint, { color: st.color }]}>{st.text}</Text>
      {(profiles.data?.names.length ?? 0) > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
          {profiles.data!.names.map((n) => (
            <Chip key={n} label={n} selected={n === profile} onPress={() => void boards.update(board.id, { profile: n })} />
          ))}
        </View>
      )}
      <View style={[s.row, { marginTop: 6, flexWrap: "wrap" }]}>
        {status.unauthorized && <Button title="Pair again" small kind="primary" onPress={() => router.push("/pair")} />}
        <Button title="Open on the web" small onPress={() => void Linking.openURL(board.url)} />
        <Button title="Remove" small kind="danger" busy={busy} onPress={remove} />
      </View>
    </Pressable>
  );
}

export default function BoardsScreen() {
  const router = useRouter();
  const { boards: list } = useBoards();
  const statuses = useBoardStatuses();
  const selected = boards.selectedBoard()?.id;
  return (
    <ScrollView style={s.screen} contentContainerStyle={{ paddingVertical: 8 }}>
      {list.map((b) => (
        <BoardCard key={b.id} board={b} status={statusOf(statuses, b.id)} selected={b.id === selected} />
      ))}
      <View style={{ padding: 12, gap: 10 }}>
        <Button title={list.length ? "Pair another board" : "Pair a board"} kind="primary" onPress={() => router.push("/pair")} />
        <Text style={s.faint}>
          The inbox shows every board's prompts and tasks that need you, for the profile picked on each. Terminals, diffs, settings and analytics are on
          the web board.
        </Text>
      </View>
    </ScrollView>
  );
}
