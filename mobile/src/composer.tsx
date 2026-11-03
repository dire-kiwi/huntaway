// The composer under a task's thread: the message, and photos from the camera or library as attachments, uploaded to
// the task's host and listed after the text (see attachments.ts).
import type { Attachment, Client, Task } from "@huntaway/client";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { photoName, withAttachments } from "./attachments";
import { colors } from "./theme";
import { Button, ErrorText, s } from "./ui";

/**
 * The field's text once `sent` (what it held when Send was pressed) has gone: empty if it's unchanged, what was typed
 * after it if it was added to, and as it is if it was changed otherwise.
 */
export function afterSend(now: string, sent: string): string {
  if (now === sent) return "";
  return now.startsWith(sent) ? now.slice(sent.length).replace(/^\s+/, "") : now;
}

/** The composer under a task's thread: a message, with photos from the camera or library uploaded to its host. */
export function Composer({
  client,
  host,
  taskId,
  bottom,
  onSent,
}: {
  client: Pick<Client, "send" | "uploadAttachment">;
  host: string;
  taskId: string;
  bottom: number;
  onSent: (t: Task) => void;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState<"send" | "photo" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const addPhoto = async (from: "camera" | "library") => {
    setErr(null);
    const perm = from === "camera" ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setErr(from === "camera" ? "Camera access is off for Huntaway: allow it in Settings." : "Photo access is off for Huntaway: allow it in Settings.");
      return;
    }
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], base64: true, quality: 0.7, allowsMultipleSelection: from === "library", selectionLimit: 5 };
    const picked = from === "camera" ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (picked.canceled) return;
    setBusy("photo");
    try {
      for (const a of picked.assets) {
        if (!a.base64) continue;
        const att = await client.uploadAttachment(host, photoName(a.fileName, a.mimeType), a.base64);
        setFiles((f) => [...f, att]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    // What goes: the field stays editable meanwhile, and only this is taken out of it once it's sent.
    const sent = { text, files };
    setBusy("send");
    setErr(null);
    try {
      onSent(await client.send(host, taskId, withAttachments(sent.text, sent.files)));
      setText((now) => afterSend(now, sent.text));
      setFiles((now) => now.filter((f) => !sent.files.some((x) => x.id === f.id)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.panel, padding: 8, paddingBottom: 8 + bottom, gap: 6 }}>
      {files.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {files.map((f) => (
            <Pressable key={f.id} onPress={() => setFiles((x) => x.filter((y) => y.id !== f.id))} accessibilityLabel={`Remove ${f.name}`} style={[s.chip, { height: 28 }]}>
              <Text style={s.faint}>📎 {f.name} ✕</Text>
            </Pressable>
          ))}
        </View>
      )}
      {err && <ErrorText>{err}</ErrorText>}
      <View style={[s.row, { alignItems: "flex-end" }]}>
        <Button title="📷" small kind="ghost" busy={busy === "photo"} onPress={() => addPhoto("camera")} />
        <Button title="🖼" small kind="ghost" disabled={busy === "photo"} onPress={() => addPhoto("library")} />
        <TextInput
          style={[s.input, { flex: 1, maxHeight: 140, paddingTop: 10 }]}
          value={text}
          onChangeText={setText}
          placeholder="Message the agent"
          placeholderTextColor={colors.faint}
          multiline
          accessibilityLabel="Message"
        />
        <Button title="Send" small kind="primary" busy={busy === "send"} disabled={busy === "send" || (!text.trim() && !files.length)} onPress={send} />
      </View>
    </View>
  );
}
