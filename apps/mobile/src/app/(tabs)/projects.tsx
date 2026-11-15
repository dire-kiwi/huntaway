import { type Board, type HostProject } from "@huntaway/client"
import { router } from "expo-router"
import { FlatList, Pressable, Text, View } from "react-native"
import { Chip, Empty, s } from "../../components/ui"
import { pickProfile, profileNames, useBoard, useProfile } from "../../state/board"

// The shown profile's projects on every host of the board, by name (a host's name with each when there are several).

/** The projects of profile `name` on every host (pure). */
export const projectsOf = (b: Pick<Board, "profiles" | "projects">, name: string | null): ReadonlyArray<HostProject> => {
  const ids = new Set(b.profiles.filter((p) => p.name === name).map((p) => `${p.host_id}/${p.id}`))
  return b.projects.filter((p) => ids.has(`${p.host_id}/${p.profile_id}`))
}

export default function ProjectsScreen() {
  const profile = useProfile()
  const names = useBoard(profileNames)
  const projects = useBoard((b) => b.projects)
  const profiles = useBoard((b) => b.profiles)
  const hosts = useBoard((b) => b.hosts)
  const loaded = useBoard((b) => b.loaded)
  const shown = projectsOf({ projects, profiles }, profile)
  const hostName = (id: string) => (hosts.length > 1 ? hosts.find((h) => h.id === id)?.name : undefined)
  return (
    <View style={s.screen}>
      {names.length > 1 && (
        <View style={[s.wrap, { padding: 12 }]}>
          {names.map((name) => (
            <Chip key={name} label={name} selected={name === profile} onPress={() => pickProfile(name)} />
          ))}
        </View>
      )}
      <FlatList
        data={shown}
        keyExtractor={(p) => `${p.host_id}/${p.id}`}
        ListEmptyComponent={<Empty title={loaded ? "No projects in this profile." : "Loading the board…"} />}
        renderItem={({ item: p }) => (
          <Pressable
            style={s.card}
            accessibilityRole="link"
            onPress={() => router.push({ pathname: "/project/[host]/[id]", params: { host: p.host_id, id: p.id } })}
          >
            <View style={s.row}>
              <Text style={[s.title, { flex: 1 }]} numberOfLines={1}>
                {p.name}
              </Text>
              <Text style={s.faint}>{p.key}</Text>
            </View>
            {hostName(p.host_id) !== undefined && <Text style={s.faint}>{hostName(p.host_id)}</Text>}
          </Pressable>
        )}
      />
    </View>
  )
}
