// Pairing: scan a board's QR code (Settings → Network access → Pair a phone), paste its link, or open the link
// (huntaway://pair?url=…&code=…), which lands here with its url and code. The code is swapped for this phone's own
// token, which goes in the keychain.
import { pairingLink, parsePairingLink } from "@huntaway/client";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import * as Device from "expo-device";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { pair, PairingError, unpairPrevious } from "../pairing";
import { boards, clearStatus } from "../session";
import { colors } from "../theme";
import { Button, ErrorText, s } from "../ui";

const defaultName = () => Device.deviceName || Device.modelName || (Platform.OS === "ios" ? "iPhone" : "Android phone");

export default function Pair() {
  const params = useLocalSearchParams<{ url?: string; code?: string }>();
  const router = useRouter();
  const fromLink = params.url && params.code ? pairingLink(params.url, params.code) : "";
  const [link, setLink] = useState(fromLink);
  const [pasted, setPasted] = useState("");
  const [name, setName] = useState(defaultName);
  const [scanning, setScanning] = useState(!fromLink);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const target = parsePairingLink(link);

  const use = (text: string) => {
    if (parsePairingLink(text)) {
      setLink(text.trim());
      setScanning(false);
      setErr(null);
    } else setErr("That isn't a Huntaway pairing link: it starts with huntaway://pair.");
  };

  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { board, token } = await pair(link, name.trim() || defaultName(), { allowHttp: __DEV__ });
      // Paired with it before: that device goes, once this one's in.
      const before = boards.board(board.id);
      const previous = before ? { deviceId: before.deviceId, token: boards.token(board.id) } : null;
      await boards.add(board, token);
      void unpairPrevious(board.url, previous, board);
      clearStatus(board.id);
      router.replace("/");
    } catch (e) {
      setErr(e instanceof PairingError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }} keyboardShouldPersistTaps="handled">
        {target ? (
          <View style={[s.card, { marginHorizontal: 0 }]}>
            <Text style={s.muted}>Pair this phone with</Text>
            <Text style={[s.title, { fontSize: 17 }]} selectable>
              {target.url}
            </Text>
            <Text style={[s.faint, { marginTop: 8 }]}>This phone's name on the board</Text>
            <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Phone" placeholderTextColor={colors.faint} />
            <Button title="Pair" kind="primary" busy={busy} onPress={go} style={{ marginTop: 8 }} />
            <Button title="Scan another code" kind="ghost" small onPress={() => (setLink(""), setScanning(true))} />
          </View>
        ) : (
          <>
            <Text style={s.muted}>
              On the board, open Settings → Network access → Pair a phone, and scan its QR code. The code works once, for five minutes.
            </Text>
            {scanning && permission?.granted ? (
              <View style={{ height: 320, borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: colors.line }}>
                <CameraView
                  style={{ flex: 1 }}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={({ data }) => {
                    if (parsePairingLink(data)) use(data);
                  }}
                />
              </View>
            ) : (
              <Button
                title={permission && !permission.canAskAgain && !permission.granted ? "Camera access is off: allow it in Settings" : "Scan the QR code"}
                kind="primary"
                onPress={async () => {
                  setScanning(true);
                  if (!permission?.granted) await requestPermission();
                }}
              />
            )}
            <Text style={[s.faint, { marginTop: 8 }]}>Or paste the link shown under it</Text>
            <TextInput
              style={s.input}
              value={pasted}
              onChangeText={setPasted}
              placeholder="huntaway://pair?url=…&code=…"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Pairing link"
            />
            <View style={s.row}>
              <Button title="Paste" small onPress={async () => setPasted(await Clipboard.getStringAsync())} />
              <Button title="Use this link" small kind="primary" disabled={!pasted.trim()} onPress={() => use(pasted)} />
            </View>
          </>
        )}
        {err && <ErrorText>{err}</ErrorText>}
        <Text style={s.faint}>
          The board must be on HTTPS at an address this phone reaches, such as with tailscale serve on its machine. The phone gets a token of its own, which you
          can revoke on the board.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
