// The board and profile switcher at the top of the Assistant and Projects tabs: chips for each paired board (when
// there are several) and each of the selected board's profiles (when it has several).
import { ScrollView, View } from "react-native";
import type { Board } from "./boards";
import type { BoardProfiles } from "./boardData";
import { boards, statusOf, useBoards, useBoardStatuses } from "./session";
import { colors } from "./theme";
import { Chip } from "./ui";

export function BoardPicker({
  board,
  profiles,
  profile,
  only,
}: {
  board: Board;
  profiles?: BoardProfiles;
  profile: string | null;
  only?: (b: Board) => boolean;
}) {
  const { boards: all } = useBoards();
  const statuses = useBoardStatuses();
  const list = only ? all.filter(only) : all;
  const many = list.length > 1;
  const names = profiles?.names ?? [];
  if (!many && names.length < 2) return null;
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: colors.line, paddingVertical: 8, gap: 8 }}>
      {many && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }} accessibilityLabel="Boards">
          {list.map((b) => (
            <Chip
              key={b.id}
              label={b.name}
              selected={b.id === board.id}
              color={statusOf(statuses, b.id).connected ? colors.green : colors.faint}
              onPress={() => void boards.select(b.id)}
            />
          ))}
        </ScrollView>
      )}
      {names.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }} accessibilityLabel="Profiles">
          {names.map((n) => (
            <Chip key={n} label={n} selected={n === profile} onPress={() => void boards.update(board.id, { profile: n })} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}
