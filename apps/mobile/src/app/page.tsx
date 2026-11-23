import { useAtomValue } from "@effect/atom-react"
import { pluginHost } from "@huntaway/client"
import { router, Stack, useLocalSearchParams } from "expo-router"
import { useState } from "react"
import { ActivityIndicator, View } from "react-native"
import { PluginFrame } from "../components/pluginFrame"
import { IconButton, s } from "../components/ui"
import { pageHref, pagePath, type PageRef } from "../logic/links"
import { useBoard } from "../state/board"
import { connectionAtom } from "../state/connection"
import { openInBrowser, param } from "../state/open"
import { colors } from "../theme"

/** The page is at another of the plugin's paths: that one takes this one's place. */
const redirect = (to: PageRef): void => router.replace({ pathname: "/page", params: { plugin: to.plugin, path: to.path, search: to.search } })

// One of a plugin's pages (HE-99; docs/plan/15-plugins.md, Pages), `/<plugin>/<path>` on the board: a document, mostly.
// Its frame fills the screen under a header with the page's title. It is its own host's page, or, when its path starts
// with a profile's id (every document's does), the page of the host that has that profile (`pluginHost`).

export default function PageScreen() {
  const params = useLocalSearchParams()
  const plugin = param(params["plugin"])
  const path = param(params["path"])
  const search = param(params["search"])
  const page: PageRef = { plugin, path, search }
  const host = useBoard((b) => pluginHost(b, pagePath(path)))
  const connection = useAtomValue(connectionAtom)
  const [title, setTitle] = useState<string | null>(null)
  const web = connection._tag === "board" ? `${connection.link.url}${pageHref(page)}` : null
  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{
          title: title ?? "",
          headerRight: () =>
            web === null ? null : <IconButton icon="open-outline" label="Open on the web" color={colors.muted} onPress={() => openInBrowser(web)} />,
        }}
      />
      {host === null ? (
        <ActivityIndicator style={{ marginTop: 32 }} color={colors.accent} />
      ) : (
        <PluginFrame key={`${host}/${plugin}/${path}?${search}`} host={host} page={page} fill onTitle={setTitle} onRedirect={redirect} />
      )}
    </View>
  )
}
