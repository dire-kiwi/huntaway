// Where something shared from another app goes, when several paired boards could take it: their assistants, the one
// it last went to first. Picking one selects that board and opens its Assistant tab with the composer filled in.
import { useRouter } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";
import { boards, statusOf, useBoards, useBoardStatuses } from "../session";
import { shares, shareTargets, usePendingShare } from "../share";
import { colors } from "../theme";
import { BoardLabel, Button, Empty, s } from "../ui";

export default function Share() {
  const router = useRouter();
  const { boards: list, lastShared } = useBoards();
  const statuses = useBoardStatuses();
  const pending = usePendingShare();
  const { boards: targets } = shareTargets(list, (id) => statusOf(statuses, id), lastShared);

  const drop = () => {
    if (pending) shares.clear(pending.id);
    router.back();
  };
  if (!pending) return <Empty title="Nothing's waiting to be shared." />;
  if (!targets.length) {
    return (
      <Empty title="None of your paired boards can take it: the assistant needs a board on Huntaway's API 102 or later. Update one, or pair another.">
        <Button title="Pair a board" kind="primary" onPress={() => router.replace("/pair")} />
        <Button title="Drop it" kind="ghost" onPress={drop} />
      </Empty>
    );
  }
  const pick = (id: string) => {
    void boards.select(id);
    void boards.shared(id);
    shares.target(id);
    router.dismissTo("/");
  };
  const { text, files } = pending.draft;
  return (
    <ScrollView style={s.screen} contentContainerStyle={{ paddingVertical: 12 }}>
      <View style={[s.card, { gap: 4 }]}>
        {!!text && (
          <Text style={s.muted} numberOfLines={4}>
            {text}
          </Text>
        )}
        {files.map((f) => (
          <Text key={f.uri} style={s.faint} numberOfLines={1}>
            📎 {f.name}
          </Text>
        ))}
      </View>
      <Text style={[s.faint, { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }]}>Which board's assistant should it go to?</Text>
      {targets.map((b) => (
        <Pressable key={b.id} accessibilityRole="button" accessibilityLabel={`Send to ${b.name}`} onPress={() => pick(b.id)} style={[s.card, s.row]}>
          <View style={[s.dot, { backgroundColor: statusOf(statuses, b.id).connected ? colors.green : colors.faint }]} />
          <Text style={[s.title, { flex: 1 }]} numberOfLines={1}>
            {b.name}
          </Text>
          {b.profile && <BoardLabel name={b.profile} />}
          {b.id === lastShared && <Text style={s.faint}>last used</Text>}
        </Pressable>
      ))}
      <Button title="Drop it" kind="ghost" onPress={drop} style={{ margin: 12 }} />
    </ScrollView>
  );
}
