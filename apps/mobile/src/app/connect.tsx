import { useAtomValue } from "@effect/atom-react"
import { router } from "expo-router"
import { useState } from "react"
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native"
import { Button, ErrorText, s } from "../components/ui"
import { insecure, parseBoardLink } from "../logic/link"
import { connect, connectionAtom } from "../state/connection"
import { colors } from "../theme"

// Connect: the board's link from its Settings → Network access (`http://<host>:<port>/?token=…`), pasted or typed, or
// its address and token apart. The board must answer before it is kept.

export default function ConnectScreen() {
  const connection = useAtomValue(connectionAtom)
  const [link, setLink] = useState(connection._tag === "board" ? connection.link.url : "")
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const parsed = parseBoardLink(link)
  const go = () => {
    if ("error" in parsed) return setError(parsed.error)
    setBusy(true)
    setError(null)
    void connect({ url: parsed.url, token: parsed.token === "" ? token.trim() : parsed.token }).then((why) => {
      setBusy(false)
      if (why !== null) return setError(why)
      if (router.canGoBack()) router.back()
      else router.replace("/")
    })
  }
  return (
    <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">
        <Text style={s.muted}>
          Open the board on a computer, go to Settings → Network access, and copy its link (Reveal, then Copy). Paste it here. The phone has to reach the board:
          on the same network, or over a VPN such as Tailscale.
        </Text>
        <View style={{ gap: 6 }}>
          <Text style={s.label}>Board link or address</Text>
          <TextInput
            style={s.input}
            value={link}
            onChangeText={setLink}
            placeholder="http://my-computer:7878/?token=…"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel="Board link or address"
          />
        </View>
        {!("error" in parsed) && parsed.token === "" && (
          <View style={{ gap: 6 }}>
            <Text style={s.label}>Token</Text>
            <TextInput
              style={s.input}
              value={token}
              onChangeText={setToken}
              placeholder="Leave empty if the board hands it out"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              accessibilityLabel="Token"
            />
          </View>
        )}
        {!("error" in parsed) && insecure(parsed.url) && (
          <Text style={[s.faint, { color: colors.amber }]}>
            This address is plain HTTP: the token, which gives full control of the board, travels unencrypted. Use it only on a network you trust, such as
            Tailscale.
          </Text>
        )}
        {error !== null && <ErrorText>{error}</ErrorText>}
        <Button title="Connect" kind="primary" busy={busy} disabled={link.trim() === ""} onPress={go} />
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
