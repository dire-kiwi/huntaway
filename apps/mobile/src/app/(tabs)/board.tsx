import { useAtomValue } from "@effect/atom-react"
import { hostSessionAtom } from "@huntaway/client"
import type { HostId } from "@huntaway/contracts"
import { router } from "expo-router"
import { Linking, ScrollView, Text, View } from "react-native"
import { Button, Chip, s, Section } from "../../components/ui"
import { pickProfile, profileNames, useBoard, useProfile } from "../../state/board"
import { connectionAtom, disconnect } from "../../state/connection"
import { colors } from "../../theme"

// The board the app shows: where it is, whether it is live, its hosts, which profile the app shows, and changing or
// forgetting it.

function SessionLine({ host }: { readonly host: HostId }) {
  const session = useAtomValue(hostSessionAtom(host))
  const state = session.state._tag
  const label =
    state === "live"
      ? "Live"
      : state === "connecting"
        ? "Connecting…"
        : state === "offline"
          ? "Offline"
          : state === "unauthorized"
            ? "Token turned down"
            : "Needs an update"
  const color = state === "live" ? colors.green : state === "connecting" ? colors.faint : colors.amber
  return <Text style={[s.muted, { color }]}>{label}</Text>
}

export default function BoardScreen() {
  const connection = useAtomValue(connectionAtom)
  const hosts = useBoard((b) => b.hosts)
  const authed = useBoard((b) => b.authed)
  const localHostId = useBoard((b) => b.localHostId)
  const names = useBoard(profileNames)
  const profile = useProfile()
  if (connection._tag !== "board") return null
  const url = connection.link.url
  return (
    <ScrollView style={s.screen} contentContainerStyle={{ paddingBottom: 32 }}>
      <View style={s.card}>
        <Text style={s.title}>{hosts.find((h) => h.local)?.name ?? url}</Text>
        <Text style={s.faint}>{url}</Text>
        {localHostId !== null ? <SessionLine host={localHostId} /> : <Text style={s.muted}>{authed === false ? "Token turned down" : "Connecting…"}</Text>}
        {authed === false && <Text style={[s.muted, { color: colors.amber }]}>The board turned this token down. Connect again with its link.</Text>}
      </View>
      {names.length > 1 && (
        <>
          <Section title="Profile" />
          <View style={[s.wrap, { paddingHorizontal: 12 }]}>
            {names.map((name) => (
              <Chip key={name} label={name} selected={name === profile} onPress={() => pickProfile(name)} />
            ))}
          </View>
        </>
      )}
      {hosts.length > 1 && (
        <>
          <Section title="Hosts" />
          {hosts.map((h) => (
            <View key={h.id} style={[s.card, s.row, { justifyContent: "space-between" }]}>
              <Text style={s.title}>{h.name}</Text>
              {h.connected ? <SessionLine host={h.id} /> : <Text style={s.faint}>Away</Text>}
            </View>
          ))}
        </>
      )}
      <Section title="This board" />
      <View style={{ paddingHorizontal: 12, gap: 8 }}>
        <Button title="Open on the web" onPress={() => void Linking.openURL(url)} />
        <Button title="Connect another board" onPress={() => router.push("/connect")} />
        <Button title="Forget this board" kind="danger" onPress={() => void disconnect().then(() => router.replace("/connect"))} />
      </View>
    </ScrollView>
  )
}
