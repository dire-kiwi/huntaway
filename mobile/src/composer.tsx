// The composer under a thread (a task's, or the assistant's): the message, photos from the camera or library, files
// shared from another app, and voice notes as attachments, uploaded to the task's host and listed after the text (see
// attachments.ts). The mic button dictates into the field; held, it records a voice note.
import type { Attachment, Client, Task } from "@huntaway/client";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { photoName, withAttachments } from "./attachments";
import { clock, useSpeech, voiceNoteName, voiceNoteText, withSpeech } from "./dictation";
import { readForUpload, type ReadFile } from "./files";
import { withDraft, type SharedFile } from "./share";
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

/** Something to put in the composer: a share from another app. A new `id` puts it in again. */
export interface Prefill {
  id: number;
  text: string;
  files: SharedFile[];
}

/** The composer under a thread: a message, with photos, shared files and voice notes uploaded to its host. */
export function Composer({
  client,
  host,
  taskId,
  bottom,
  onSent,
  placeholder = "Message the agent",
  prefill,
  onPrefilled,
  readFile = readForUpload,
}: {
  client: Pick<Client, "send" | "uploadAttachment">;
  host: string;
  taskId: string;
  bottom: number;
  onSent: (t: Task) => void;
  placeholder?: string;
  prefill?: Prefill | null;
  /** The prefill was taken (its text is in the field, and its files are uploading). */
  onPrefilled?: (id: number) => void;
  readFile?: ReadFile;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  // Sending and uploading are tracked apart: a photo picked while a message is sending mustn't make Send usable again.
  const [sending, setSending] = useState(false);
  const [uploads, setUploads] = useState(0);
  // Set at once, before a render, so a second tap can't send the same message again.
  const inFlight = useRef(false);
  const [err, setErr] = useState<string | null>(null);
  // What the field held when dictation started, which what's said goes after.
  const before = useRef("");

  /** Uploads local files to the host, adding each to the message as it's in. */
  const upload = async (list: { name: string; data: () => Promise<string> }[]) => {
    if (!list.length) return;
    setUploads((n) => n + 1);
    try {
      for (const f of list) {
        try {
          const att = await client.uploadAttachment(host, f.name, await f.data());
          setFiles((x) => [...x, att]);
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      }
    } finally {
      setUploads((n) => n - 1);
    }
  };

  const speech = useSpeech({
    onText: (said) => setText(withSpeech(before.current, said)),
    onNote: (uri, transcript) => {
      const added = voiceNoteText(transcript);
      if (added) setText((t) => withDraft(t, added));
      void upload([{ name: voiceNoteName(uri), data: () => readFile(uri, "The voice note") }]);
    },
  });

  // A share from another app: its text goes after what's typed, and its files upload to this thread's host.
  const taken = useRef<number | null>(null);
  useEffect(() => {
    if (!prefill || taken.current === prefill.id) return;
    taken.current = prefill.id;
    onPrefilled?.(prefill.id);
    setErr(null);
    setText((t) => withDraft(t, prefill.text));
    // While dictating, the field is rewritten from what it held before, which the share now joins.
    if (speech.mode === "dictate") before.current = withDraft(before.current, prefill.text);
    void upload(prefill.files.map((f) => ({ name: f.name, data: () => readFile(f.uri, f.name) })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.id]);

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
    await upload(picked.assets.filter((a) => a.base64).map((a) => ({ name: photoName(a.fileName, a.mimeType), data: async () => a.base64! })));
  };

  const dictate = () => {
    if (speech.mode) return speech.stop();
    before.current = text;
    void speech.start("dictate");
  };
  const record = () => {
    if (speech.mode) return;
    void speech.start("note");
  };

  const send = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    // What goes: the field stays editable meanwhile, and only this is taken out of it once it's sent.
    const sent = { text, files };
    setSending(true);
    setErr(null);
    try {
      onSent(await client.send(host, taskId, withAttachments(sent.text, sent.files)));
      setText((now) => afterSend(now, sent.text));
      setFiles((now) => now.filter((f) => !sent.files.some((x) => x.id === f.id)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  const error = err ?? speech.error;
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.panel, padding: 8, paddingBottom: 8 + bottom, gap: 6 }}>
      {files.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {files.map((f) => (
            <Pressable key={f.id} onPress={() => setFiles((x) => x.filter((y) => y.id !== f.id))} accessibilityLabel={`Remove ${f.name}`} style={[s.chip, { height: 28 }]}>
              <Text style={s.faint}>
                {/^voice-note-/.test(f.name) ? "🎙" : "📎"} {f.name} ✕
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {speech.mode && (
        <View style={[s.row, { paddingHorizontal: 4 }]} accessibilityLiveRegion="polite">
          <View style={[s.dot, { backgroundColor: colors.red }]} />
          <Text style={[s.muted, { flex: 1 }]} numberOfLines={2}>
            {speech.mode === "note" ? `Voice note ${clock(speech.elapsed)}` : "Listening"}
            {speech.onDevice ? " · on this phone" : ""}
            {speech.mode === "note" && speech.transcript ? ` · ${speech.transcript}` : ""}
          </Text>
          {speech.mode === "note" ? (
            <>
              <Button title="Cancel" small kind="ghost" onPress={speech.cancel} />
              <Button title="Attach" small kind="primary" onPress={speech.stop} />
            </>
          ) : (
            <Button title="Done" small onPress={speech.stop} />
          )}
        </View>
      )}
      {error && (
        <Text onPress={() => (setErr(null), speech.clearError())}>
          <ErrorText>{error}</ErrorText>
        </Text>
      )}
      <View style={[s.row, { alignItems: "flex-end", gap: 2 }]}>
        <Button title="📷" small kind="ghost" busy={uploads > 0} onPress={() => addPhoto("camera")} style={icon} />
        <Button title="🖼" small kind="ghost" disabled={uploads > 0} onPress={() => addPhoto("library")} style={icon} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={speech.mode === "dictate" ? "Stop dictating" : "Dictate"}
          accessibilityHint="Hold to record a voice note instead"
          accessibilityState={{ disabled: speech.mode === "note", selected: !!speech.mode }}
          accessibilityActions={[{ name: "activate" }, { name: "longpress", label: "Record a voice note" }]}
          onAccessibilityAction={(e) => (e.nativeEvent.actionName === "longpress" ? record() : dictate())}
          disabled={speech.mode === "note"}
          onPress={dictate}
          onLongPress={record}
          delayLongPress={400}
          style={({ pressed }) => [s.button, s.small, s.ghost, icon, speech.mode === "note" && s.disabled, pressed && s.pressed]}
        >
          <Text style={{ fontSize: 16, color: speech.mode ? colors.red : colors.fg }}>{speech.mode === "dictate" ? "■" : "🎤"}</Text>
        </Pressable>
        <TextInput
          style={[s.input, { flex: 1, maxHeight: 140, paddingTop: 10, marginHorizontal: 4 }]}
          value={text}
          onChangeText={setText}
          // While dictating, the field shows what's heard: typing then would be written over.
          editable={speech.mode !== "dictate"}
          placeholder={placeholder}
          placeholderTextColor={colors.faint}
          multiline
          accessibilityLabel="Message"
        />
        <Button
          title="Send"
          small
          kind="primary"
          busy={sending}
          // Not while a photo's uploading either, or while the mic's on: a voice note would be left out, and dictation would
          // write the sent text back into the field.
          disabled={sending || uploads > 0 || !!speech.mode || (!text.trim() && !files.length)}
          onPress={send}
        />
      </View>
    </View>
  );
}

/** The icon buttons beside the field, narrow enough to leave it room on a phone. */
const icon = { paddingHorizontal: 7 };
