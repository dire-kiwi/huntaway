// Projects: the selected board's projects for its picked profile, with a switcher for the board and the profile.
import { useRouter } from "expo-router";
import { FlatList, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { loadProfiles, loadProjects, pickedProfile } from "../../boardData";
import { boards, clientFor, statusOf, usable, useBoards, useBoardStatuses, useLoad, useRefetchOn } from "../../session";
import { colors } from "../../theme";
import { Button, Chip, Empty, ErrorText, s } from "../../ui";

export default function Projects() {
  const router = useRouter();
  const { boards: list } = useBoards();
  const statuses = useBoardStatuses();
  const board = boards.selectedBoard();
  const ok = !!board && usable(statusOf(statuses, board.id));
  const client = board && clientFor(board);

  const profiles = useLoad(async () => (client && ok ? loadProfiles(client) : undefined), [board?.id, board?.url, ok]);
  const profile = board ? pickedProfile(board, profiles.data) : null;
  const projects = useLoad(async () => (client && profiles.data && profile ? loadProjects(client, profiles.data, profile) : []), [profiles.data, profile]);
  useRefetchOn((b, ev) => b === board?.id && ["project", "project_deleted", "resync", "hosts_changed"].includes(ev.type), projects.reload);
  useRefetchOn((b, ev) => b === board?.id && ev.type === "profiles_changed", profiles.reload);

  if (!board) {
    return (
      <View style={s.screen}>
        <Empty title="Pair the app with a board to see its projects.">
          <Button title="Pair a board" kind="primary" onPress={() => router.push("/pair")} />
        </Empty>
      </View>
    );
  }
  return (
    <View style={s.screen}>
      <View style={{ borderBottomWidth: 1, borderBottomColor: colors.line, paddingVertical: 8, gap: 8 }}>
        {list.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }} accessibilityLabel="Boards">
            {list.map((b) => (
              <Chip
                key={b.id}
                label={b.name}
                selected={b.id === board.id}
                color={statusOf(statuses, b.id).connected ? colors.green : colors.faint}
                onPress={() => void boards.select(b.id)}
              />
            ))}
          </ScrollView>
        )}
        {(profiles.data?.names.length ?? 0) > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }} accessibilityLabel="Profiles">
            {profiles.data!.names.map((n) => (
              <Chip key={n} label={n} selected={n === profile} onPress={() => void boards.update(board.id, { profile: n })} />
            ))}
          </ScrollView>
        )}
      </View>
      {!ok ? (
        <Empty title={statusOf(statuses, board.id).unauthorized ? `This phone was unpaired from ${board.name}. Pair it again.` : `${board.name}'s Huntaway is too old for the app. Update it.`} />
      ) : (
        <FlatList
          data={projects.data ?? []}
          keyExtractor={(p) => `${p.hostId}/${p.id}`}
          refreshControl={<RefreshControl refreshing={projects.loading && !!projects.data} onRefresh={() => (profiles.reload(), projects.reload())} tintColor={colors.accent} />}
          ListHeaderComponent={
            <>
              {profiles.error && <ErrorText>{profiles.error}</ErrorText>}
              {projects.error && <ErrorText>{projects.error}</ErrorText>}
            </>
          }
          ListEmptyComponent={projects.loading || profiles.loading ? undefined : <Empty title={profile ? `${profile} has no projects on ${board.name}.` : `${board.name} has no profiles yet.`} />}
          renderItem={({ item: p }) => (
            <Pressable
              style={s.card}
              accessibilityRole="link"
              onPress={() => router.push({ pathname: "/project/[board]/[host]/[id]", params: { board: board.id, host: p.hostId, id: p.id, name: p.name } })}
            >
              <View style={s.row}>
                <Text style={[s.faint, { fontWeight: "700" }]}>{p.key}</Text>
                <Text style={s.title} numberOfLines={1}>
                  {p.name}
                </Text>
              </View>
              {(profiles.data?.hostNames.size ?? 0) > 1 && <Text style={s.faint}>on {profiles.data!.hostNames.get(p.hostId) ?? p.hostId}</Text>}
            </Pressable>
          )}
        />
      )}
    </View>
  );
}
