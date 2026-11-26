import { useAtomValue } from "@effect/atom-react"
import { query } from "@huntaway/client"
import { AsyncResult } from "effect/reactivity"
import { useState } from "react"
import { ActivityIndicator, ScrollView, View } from "react-native"
import { PluginFrame } from "../../components/pluginFrame"
import { Chip, Empty, s } from "../../components/ui"
import { useBoard, useProfile } from "../../state/board"
import { openPage } from "../../state/open"
import { colors, space } from "../../theme"

// Docs (HE-99): the shown profile's documents, which are the docs plugin's pages (docs/plan/15-plugins.md): its home
// page for the profile, in a frame; a document opens over it (app/page.tsx). A plugin keeps its documents per host, so
// a profile on several hosts says which host's are shown.

function DocsOf({ host, profileId }: { readonly host: string; readonly profileId: string }) {
  const plugins = useAtomValue(query("plugins.list", host, undefined))
  if (AsyncResult.isFailure(plugins)) return <Empty icon="cloud-offline-outline" title="This host's documents can't be read." />
  if (!AsyncResult.isSuccess(plugins)) return <ActivityIndicator style={{ marginTop: 32 }} color={colors.accent} />
  const docs = plugins.value.find((p) => p.id === "docs")
  if (docs === undefined)
    return <Empty icon="document-text-outline" title="This board has no documents." hint="Its server was built without the docs plugin." />
  if (docs.error !== null) return <Empty icon="alert-circle-outline" title="Docs isn't running." hint={docs.error} />
  return <PluginFrame key={`${host}/${profileId}`} host={host} page={{ plugin: "docs", path: profileId, search: "" }} fill onRedirect={openPage} />
}

export default function DocsScreen() {
  const profile = useProfile()
  const profiles = useBoard((b) => b.profiles)
  const hosts = useBoard((b) => b.hosts)
  const loaded = useBoard((b) => b.loaded)
  const [pickedHost, setPickedHost] = useState<string | null>(null)
  const homes = profiles.flatMap((p) => {
    const host = hosts.find((h) => h.id === p.host_id)
    return p.name === profile && host?.connected === true ? [{ host, profileId: p.id }] : []
  })
  const home = homes.find((h) => h.host.id === pickedHost) ?? homes.find((h) => h.host.local) ?? homes[0]
  if (home === undefined)
    return (
      <View style={s.screen}>
        {loaded ? <Empty icon="document-text-outline" title="No host with this profile is connected." /> : <Empty title="Loading the board…" />}
      </View>
    )
  return (
    <View style={s.screen}>
      {homes.length > 1 && (
        <View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: space.sm, paddingHorizontal: space.md, paddingBottom: space.sm }}
          >
            {homes.map((h) => (
              <Chip
                key={h.host.id}
                label={h.host.name}
                icon="hardware-chip-outline"
                selected={h.host.id === home.host.id}
                onPress={() => setPickedHost(h.host.id)}
              />
            ))}
          </ScrollView>
        </View>
      )}
      <DocsOf host={home.host.id} profileId={home.profileId} />
    </View>
  )
}
