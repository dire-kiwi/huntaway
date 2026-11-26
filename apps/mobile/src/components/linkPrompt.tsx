import { useAtom } from "@effect/atom-react"
import { Text, View } from "react-native"
import { askedLinkAtom, openInBrowser } from "../state/open"
import { colors, space } from "../theme"
import { Button, s, Sheet } from "./ui"

// The question before a link leaves the app (state/open.ts): where it goes, in full, and the choice.

export function LinkPrompt() {
  const [url, setUrl] = useAtom(askedLinkAtom)
  if (url === null) return null
  return (
    <Sheet
      title="Open this link?"
      onClose={() => setUrl(null)}
      footer={
        <View style={[s.row, { justifyContent: "flex-end" }]}>
          <Button title="Cancel" kind="ghost" onPress={() => setUrl(null)} />
          <Button
            title="Open in the browser"
            kind="primary"
            icon="open-outline"
            onPress={() => {
              setUrl(null)
              openInBrowser(url)
            }}
          />
        </View>
      }
    >
      <View style={{ paddingHorizontal: space.sm, gap: space.sm }}>
        <Text style={s.muted}>It leaves the app, and goes to:</Text>
        <Text style={[s.body, { color: colors.accent }]} selectable>
          {url}
        </Text>
      </View>
    </Sheet>
  )
}
