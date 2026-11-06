// A share that's waiting, on the Assistant tab: for this board's assistant (until it opens: its host may be offline), for
// another board's (picked before switching here), or for no board yet (the share screen was closed without picking one).
// It says so, and can be dropped.
import { useRouter } from "expo-router";
import { Text, View } from "react-native";
import type { Board } from "./boards";
import { shares, type PendingShare } from "./share";
import { colors } from "./theme";
import { Button, s } from "./ui";

/** What the card says about a waiting share, seen on `board`'s Assistant tab; none when the composer's taking it. */
export function waitingNote(
  pending: PendingShare | null,
  board: Pick<Board, "id">,
  boardName: (id: string) => string | undefined,
  taking: boolean,
): string | null {
  if (!pending) return null;
  if (pending.boardId === board.id) return taking ? null : "What you shared waits here until the assistant opens.";
  if (pending.boardId) return `What you shared is waiting for ${boardName(pending.boardId) ?? "another board"}'s assistant.`;
  return "What you shared hasn't gone anywhere yet: pick the board whose assistant it's for.";
}

export function WaitingShare({
  pending,
  board,
  boardName,
  taking,
}: {
  pending: PendingShare | null;
  board: Board;
  boardName: (id: string) => string | undefined;
  taking: boolean;
}) {
  const router = useRouter();
  const note = waitingNote(pending, board, boardName, taking);
  if (!pending || !note) return null;
  const { text, files } = pending.draft;
  const what = [text.split("\n")[0], ...files.map((f) => f.name)].filter(Boolean).join(" · ");
  return (
    <View style={[s.card, { borderColor: colors.accent }]} accessibilityLabel="Waiting share">
      <Text style={s.muted}>{note}</Text>
      {!!what && (
        <Text style={s.faint} numberOfLines={2}>
          {what}
        </Text>
      )}
      <View style={s.row}>
        {!pending.boardId && (
          <Button title="Pick a board" small kind="primary" onPress={() => router.push({ pathname: "/share", params: { id: String(pending.id) } })} />
        )}
        <Button title="Drop it" small kind="ghost" onPress={() => shares.clear(pending.id)} />
      </View>
    </View>
  );
}
