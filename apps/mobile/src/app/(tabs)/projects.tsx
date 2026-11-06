// Projects: the selected board's projects for its picked profile, with a switcher for the board and the profile.
import { useRouter } from "expo-router";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { BoardPicker } from "../../boardPicker";
import { loadProfiles, loadProjects, pickedProfile, profilesOf } from "../../boardData";
import { boards, clientFor, statusOf, usable, useBoards, useBoardStatuses, useLoad, useRefetchOn } from "../../session";
import { colors } from "../../theme";
import { Button, Empty, ErrorText, s } from "../../ui";

export default function Projects() {
  const router = useRouter();
  useBoards();
  const statuses = useBoardStatuses();
  const board = boards.selectedBoard();
  const ok = !!board && usable(statusOf(statuses, board.id));
  const client = board && clientFor(board);

  const loadedProfiles = useLoad(async () => (board && client && ok ? loadProfiles(client, board.id) : undefined), [board?.id, board?.url, ok]);
  // Only this board's: another's may still be there for the render after a switch, before its load starts.
  const profileData = profilesOf(board, loadedProfiles.data);
  const profiles = { ...loadedProfiles, data: profileData };
  const profile = board ? pickedProfile(board, profileData) : null;
  const loadedProjects = useLoad(
    async () => (client && profileData && profile ? loadProjects(client, profileData, profile) : []),
    [board?.id, board?.url, profileData, profile],
  );
  const projects = { ...loadedProjects, data: loadedProjects.data?.filter((p) => p.boardId === board?.id) };
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
      <BoardPicker board={board} profiles={profiles.data} profile={profile} />
      {!ok ? (
        <Empty
          title={
            statusOf(statuses, board.id).unauthorized
              ? `This phone was unpaired from ${board.name}. Pair it again.`
              : `${board.name}'s Huntaway is too old for the app. Update it.`
          }
        />
      ) : (
        <FlatList
          data={projects.data ?? []}
          keyExtractor={(p) => `${p.hostId}/${p.id}`}
          refreshControl={
            <RefreshControl
              refreshing={projects.loading && !!projects.data}
              onRefresh={() => (profiles.reload(), projects.reload())}
              tintColor={colors.accent}
            />
          }
          ListHeaderComponent={
            <>
              {profiles.error && <ErrorText>{profiles.error}</ErrorText>}
              {projects.error && <ErrorText>{projects.error}</ErrorText>}
            </>
          }
          ListEmptyComponent={
            projects.loading || profiles.loading ? undefined : (
              <Empty title={profile ? `${profile} has no projects on ${board.name}.` : `${board.name} has no profiles yet.`} />
            )
          }
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
