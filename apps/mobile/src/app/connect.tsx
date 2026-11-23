import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { router } from "expo-router"
import { useState } from "react"
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native"
import { Button, ErrorText, s, Section } from "../components/ui"
import { BOARD_PORT, type FoundBoard, parsePort, pinOf } from "../logic/discovery"
import { insecure, parseBoardLink } from "../logic/link"
import { connect, connectionAtom } from "../state/connection"
import { boardsOnNetworkAtom } from "../state/discovery"
import { colors } from "../theme"

// Connect (HE-91): the boards on the phone's network, found by asking its Wi-Fi; one is picked and paired with by the
// PIN its Settings → Network access shows. Or a board's address typed in (one on Tailscale, another port, an older
// board), with a PIN, or the board's own link with its token. The board must answer before it is kept.

/** Goes back to where the app was, now that it is connected. */
const leave = () => {
  if (router.canGoBack()) router.back()
  else router.replace("/")
}

/** A board found on the network: tapped, it asks for the PIN its board shows (an older board takes its link instead). */
function FoundRow({ board, open, onOpen }: { readonly board: FoundBoard; readonly open: boolean; readonly onOpen: () => void }) {
  const [pin, setPin] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const digits = pinOf(pin)
  const pair = () => {
    if (digits === null) return
    setBusy(true)
    setError(null)
    connect(
      { url: board.url, token: "" },
      (why) => {
        setBusy(false)
        if (why !== null) return setError(why)
        leave()
      },
      digits,
    )
  }
  return (
    <View style={[s.card, open && { borderColor: colors.accent }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Board ${board.name}`} onPress={onOpen} style={{ gap: 2 }}>
        <Text style={s.title}>{board.name}</Text>
        <Text style={s.faint}>{board.url.replace(/^http:\/\//, "")}</Text>
      </Pressable>
      {open &&
        (board.pairs ? (
          <View style={{ gap: 8, paddingTop: 6 }}>
            <Text style={s.muted}>On the board, open Settings → Network access, choose Pair a phone, and type the PIN it shows.</Text>
            <TextInput
              style={[s.input, { fontSize: 22, letterSpacing: 6, textAlign: "center" }]}
              value={pin}
              onChangeText={setPin}
              onSubmitEditing={pair}
              placeholder="000 000"
              placeholderTextColor={colors.faint}
              keyboardType="number-pad"
              maxLength={7}
              autoFocus
              accessibilityLabel="PIN"
            />
            {error !== null && <ErrorText>{error}</ErrorText>}
            <Button title="Pair" kind="primary" busy={busy} disabled={digits === null} onPress={pair} />
          </View>
        ) : (
          <Text style={[s.muted, { color: colors.amber }]}>
            This board is older and doesn&apos;t pair by PIN: copy its link from Settings → Network access on the board and paste it below.
          </Text>
        ))}
    </View>
  )
}

/** The boards on the phone's network, on the port given. */
function OnThisNetwork() {
  const [portText, setPortText] = useState(String(BOARD_PORT))
  const port = parsePort(portText) ?? BOARD_PORT
  const atom = boardsOnNetworkAtom(port)
  const result = useAtomValue(atom)
  const again = useAtomRefresh(atom)
  const [open, setOpen] = useState<string | null>(null)
  const found = AsyncResult.getOrElse(result, (): ReadonlyArray<FoundBoard> => [])
  const looking = result.waiting || AsyncResult.isInitial(result)
  return (
    <>
      <Section
        title="Boards on this network"
        right={looking ? <ActivityIndicator size="small" color={colors.faint} /> : <Button title="Look again" kind="ghost" small onPress={again} />}
      />
      {found.map((board) => (
        <FoundRow key={board.hostId} board={board} open={open === board.hostId} onOpen={() => setOpen(open === board.hostId ? null : board.hostId)} />
      ))}
      <View style={{ paddingHorizontal: 16, gap: 8 }}>
        {found.length === 0 && (
          <Text style={s.muted}>
            {looking
              ? "Looking on this phone's Wi-Fi…"
              : "No board answered. The phone has to be on the same Wi-Fi as the board, and the board listening on the network (its default)."}
          </Text>
        )}
        <View style={[s.row, { justifyContent: "flex-end" }]}>
          <Text style={s.faint}>Port</Text>
          <TextInput
            style={[s.input, { minHeight: 32, width: 76, paddingHorizontal: 8, fontSize: 13 }]}
            value={portText}
            onChangeText={setPortText}
            keyboardType="number-pad"
            maxLength={5}
            accessibilityLabel="Port"
          />
        </View>
      </View>
    </>
  )
}

/** A board by its address: with a PIN it pairs, with its link's token (or none, for an open board) it connects. */
function ByAddress() {
  const connection = useAtomValue(connectionAtom)
  const [link, setLink] = useState(connection._tag === "board" ? connection.link.url : "")
  const [secret, setSecret] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const parsed = parseBoardLink(link)
  const pin = pinOf(secret)
  const go = () => {
    if ("error" in parsed) return setError(parsed.error)
    setBusy(true)
    setError(null)
    const token = parsed.token === "" && pin === null ? secret.trim() : parsed.token
    connect(
      { url: parsed.url, token },
      (why) => {
        setBusy(false)
        if (why !== null) return setError(why)
        leave()
      },
      parsed.token === "" ? pin : null,
    )
  }
  return (
    <>
      <Section title="Or type its address" />
      <View style={{ paddingHorizontal: 16, gap: 14 }}>
        <Text style={s.muted}>
          For a board on Tailscale, another network or another port: its address, then the PIN it shows in Settings → Network access. Its link from there
          (Reveal, then Copy), token and all, works too.
        </Text>
        <View style={{ gap: 6 }}>
          <Text style={s.label}>Board link or address</Text>
          <TextInput
            style={s.input}
            value={link}
            onChangeText={setLink}
            placeholder="http://my-computer:7879"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel="Board link or address"
          />
        </View>
        {!("error" in parsed) && parsed.token === "" && (
          <View style={{ gap: 6 }}>
            <Text style={s.label}>PIN or token</Text>
            <TextInput
              style={s.input}
              value={secret}
              onChangeText={setSecret}
              placeholder="The PIN the board shows, or empty if it hands out its token"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={secret !== "" && pin === null}
              accessibilityLabel="PIN or token"
            />
          </View>
        )}
        {!("error" in parsed) && insecure(parsed.url) && (
          <Text style={[s.faint, { color: colors.amber }]}>
            This address is plain HTTP: what the phone sends the board travels unencrypted. Use it only on a network you trust, such as your own Wi-Fi or
            Tailscale.
          </Text>
        )}
        {error !== null && <ErrorText>{error}</ErrorText>}
        <Button
          title={!("error" in parsed) && parsed.token === "" && pin !== null ? "Pair" : "Connect"}
          kind="primary"
          busy={busy}
          disabled={link.trim() === ""}
          onPress={go}
        />
      </View>
    </>
  )
}

export default function ConnectScreen() {
  return (
    <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={{ paddingBottom: 32, gap: 4 }} keyboardShouldPersistTaps="handled">
        <OnThisNetwork />
        <ByAddress />
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
