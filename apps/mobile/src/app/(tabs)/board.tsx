import { useAtomValue } from "@effect/atom-react"
import { hostSessionAtom, query } from "@huntaway/client"
import type { HostId } from "@huntaway/contracts"
import { AsyncResult } from "effect/reactivity"
import { router } from "expo-router"
import { useState } from "react"
import { ScrollView, Text, View } from "react-native"
import { Button, Chip, Pill, s, Section, Sheet, SheetRow } from "../../components/ui"
import { pickProfile, profileNames, useBoard, useProfile } from "../../state/board"
import { connectionAtom, disconnect } from "../../state/connection"
import { openInBrowser, openPage } from "../../state/open"
import { colors, space } from "../../theme"

// The board the app shows: where it is, whether it is live, its hosts, which profile the app shows, its plugins' other
// pages (HE-99: Docs has a tab of its own), and changing or forgetting it (asked about first).

function SessionPill({ host }: { readonly host: HostId }) {
  const session = useAtomValue(hostSessionAtom(host))
  const state = session.state._tag
  if (state === "live") return <Pill label="Live" color={colors.green} />
  if (state === "connecting") return <Pill label="Connecting…" color={colors.muted} busy />
  return (
    <Pill
      label={state === "offline" ? "Offline" : state === "unauthorized" ? "Turned down" : "Needs an update"}
      color={colors.amber}
      icon="alert-circle-outline"
    />
  )
}

/** The pages the host's plugins put in the board's menu, other than Docs. */
function Pages({ host }: { readonly host: HostId }) {
  const plugins = useAtomValue(query("plugins.list", host, undefined))
  const pages = AsyncResult.isSuccess(plugins) ? plugins.value.filter((p) => p.nav !== null && p.error === null && p.id !== "docs") : []
  if (pages.length === 0) return null
  return (
    <>
      <Section title="Pages" />
      <View style={[s.card, { padding: space.xs, gap: 0 }]}>
        {pages.map((p) => (
          <SheetRow key={p.id} icon="browsers-outline" label={p.nav?.title ?? p.name} onPress={() => openPage({ plugin: p.id, path: "", search: "" })} />
        ))}
      </View>
    </>
  )
}

export default function BoardScreen() {
  const connection = useAtomValue(connectionAtom)
  const hosts = useBoard((b) => b.hosts)
  const authed = useBoard((b) => b.authed)
  const localHostId = useBoard((b) => b.localHostId)
  const names = useBoard(profileNames)
  const profile = useProfile()
  const [forgetting, setForgetting] = useState(false)
  if (connection._tag !== "board") return null
  const url = connection.link.url
  const name = hosts.find((h) => h.local)?.name ?? url
  return (
    <ScrollView style={s.screen} contentContainerStyle={{ paddingBottom: space.xl }}>
      <View style={[s.card, { padding: space.lg, gap: space.sm }]}>
        <View style={[s.row, { justifyContent: "space-between" }]}>
          <Text style={[s.title, { fontSize: 18, flex: 1 }]} numberOfLines={1}>
            {name}
          </Text>
          {localHostId !== null ? (
            <SessionPill host={localHostId} />
          ) : (
            <Pill label={authed === false ? "Turned down" : "Connecting…"} color={authed === false ? colors.amber : colors.muted} busy={authed !== false} />
          )}
        </View>
        <Text style={s.muted} selectable>
          {url.replace(/^https?:\/\//, "")}
        </Text>
        {authed === false && (
          <Text style={[s.muted, { color: colors.amber }]}>The board turned this phone down: it was unpaired, or its token changed. Pair with it again.</Text>
        )}
      </View>
      {names.length > 1 && (
        <>
          <Section title="Profile" />
          <View style={[s.wrap, { paddingHorizontal: space.md }]}>
            {names.map((n) => (
              <Chip key={n} label={n} icon="person-circle-outline" selected={n === profile} onPress={() => pickProfile(n)} />
            ))}
          </View>
        </>
      )}
      {hosts.length > 1 && (
        <>
          <Section title="Hosts" />
          <View style={[s.card, { gap: space.md }]}>
            {hosts.map((h) => (
              <View key={h.id} style={[s.row, { justifyContent: "space-between" }]}>
                <Text style={[s.body, { flex: 1 }]} numberOfLines={1}>
                  {h.name}
                </Text>
                {h.connected ? <SessionPill host={h.id} /> : <Pill label="Away" color={colors.faint} />}
              </View>
            ))}
          </View>
        </>
      )}
      {localHostId !== null && <Pages host={localHostId} />}
      <Section title="This board" />
      <View style={[s.card, { padding: space.xs, gap: 0 }]}>
        <SheetRow icon="open-outline" label="Open on the web" onPress={() => openInBrowser(url)} />
        <SheetRow icon="add-circle-outline" label="Connect another board" onPress={() => router.push("/connect")} />
        <SheetRow icon="log-out-outline" label="Forget this board" danger onPress={() => setForgetting(true)} />
      </View>
      {forgetting && (
        <Sheet
          title="Forget this board?"
          onClose={() => setForgetting(false)}
          footer={
            <View style={[s.row, { justifyContent: "flex-end" }]}>
              <Button title="Cancel" kind="ghost" onPress={() => setForgetting(false)} />
              <Button title="Forget it" kind="danger" icon="log-out-outline" onPress={() => disconnect(() => router.replace("/connect"))} />
            </View>
          }
        >
          <Text style={[s.muted, { paddingHorizontal: space.sm }]}>
            The phone unpairs from {name} and forgets its address. The board and its tasks stay as they are; pair again to come back.
          </Text>
        </Sheet>
      )}
    </ScrollView>
  )
}
