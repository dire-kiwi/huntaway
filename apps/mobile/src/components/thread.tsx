import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { actionOf, segments } from "@huntaway/a2ui"
import { olderPage, threadAtom, threadPreviewAtom } from "@huntaway/client"
import type { Task } from "@huntaway/contracts"
import { useMemo } from "react"
import { ActivityIndicator, FlatList, Text, View } from "react-native"
import { type Row, shortToolName, threadRows } from "../logic/thread"
import { colors } from "../theme"
import { Markdown } from "./markdown"
import { RequestCard } from "./requests"
import { Button, Empty, ErrorText, s } from "./ui"

// A task's thread on the phone: @huntaway/client's `threadAtom` (a window of its last items, followed live, older pages
// on request) drawn as rows, newest at the bottom, with the reply being written (`threadPreviewAtom`) under them as
// plain text: parsing it as Markdown again for each token would take longer the longer it got.

const TOOL_COLOR: Readonly<Record<string, string>> = {
  pending: colors.faint,
  running: colors.blue,
  completed: colors.green,
  failed: colors.red,
  denied: colors.red,
  cancelled: colors.faint,
}

function RowView({ row, host, taskId }: { readonly row: Row; readonly host: string; readonly taskId: string }) {
  switch (row.type) {
    case "user":
      return (
        <View style={[s.card, { alignSelf: "flex-end", maxWidth: "88%", backgroundColor: colors.raised }]}>
          <Text style={s.body}>{actionOf(row.text)?.label ?? row.text}</Text>
        </View>
      )
    case "text":
      return (
        <View style={{ paddingHorizontal: 14, paddingVertical: 6 }}>
          {/* HE-77: an interactive (A2UI) block is drawn on the web board; here it's a note in its place. */}
          {segments(row.text).map((part) =>
            part.kind === "markdown" ? (
              <Markdown key={`md@${part.offset}`} text={part.text} />
            ) : (
              <Text key={`a2ui@${part.offset}`} style={[s.faint, { fontStyle: "italic", paddingVertical: 4 }]}>
                An interactive reply: open the task on the board in a browser to use it.
              </Text>
            ),
          )}
        </View>
      )
    case "tool":
      return (
        <View style={[s.row, { paddingHorizontal: 14, paddingVertical: 3 }]}>
          <Text style={{ color: TOOL_COLOR[row.status] ?? colors.faint, fontSize: 13, fontWeight: "600" }}>{shortToolName(row.name)}</Text>
          <Text style={[s.faint, { flex: 1 }]} numberOfLines={1}>
            {row.summary}
          </Text>
        </View>
      )
    case "notice":
      return (
        <Text
          style={[
            s.faint,
            { paddingHorizontal: 14, paddingVertical: 4, color: row.level === "error" ? colors.red : row.level === "warning" ? colors.amber : colors.faint },
          ]}
        >
          {row.text}
        </Text>
      )
    case "report":
      return (
        <View style={s.card}>
          <Text style={s.label}>
            {row.automation} · {row.outcome}
          </Text>
          <Markdown text={row.text} />
        </View>
      )
    case "failed":
      return (
        <View style={[s.card, { borderColor: colors.red }]}>
          <ErrorText>{row.text}</ErrorText>
        </View>
      )
    case "request":
      return <RequestCard host={host} taskId={taskId} request={row.request} />
  }
  return null
}

export function ThreadView({ host, task, emptyTitle }: { readonly host: string; readonly task: Task; readonly emptyTitle?: string }) {
  const ref = { host_id: host, task_id: task.id }
  const view = useAtomValue(threadAtom(ref))
  const preview = useAtomValue(threadPreviewAtom(ref))
  const older = useAtomSet(olderPage(ref))
  // Newest first, for the inverted list.
  const rows = useMemo(() => (view.snap === null ? [] : threadRows(view.snap).toReversed()), [view.snap])
  if (view.failed !== null) return <Empty title={view.failed} />
  if (view.snap === null) return <ActivityIndicator style={{ marginTop: 32 }} color={colors.accent} />
  const more = (view.snap.start ?? 0) > 0
  return (
    <FlatList
      inverted
      data={rows}
      keyExtractor={(row) => row.key}
      renderItem={({ item }) => <RowView row={item} host={host} taskId={task.id} />}
      contentContainerStyle={{ paddingVertical: 8, flexGrow: 1 }}
      keyboardShouldPersistTaps="handled"
      ListEmptyComponent={
        // Drawn upside down in an inverted list unless turned back.
        <View style={{ transform: [{ scaleY: -1 }] }}>
          <Empty title={task.running ? "The agent is starting…" : (emptyTitle ?? "No messages yet.")} />
        </View>
      }
      ListHeaderComponent={
        preview !== null && preview.text !== "" ? (
          <View style={[s.card, { borderColor: colors.accent }]}>
            <Text style={s.body}>{preview.text}</Text>
          </View>
        ) : task.running && task.background_work?.idle !== true ? (
          <Text style={[s.faint, { padding: 12 }]}>The agent is working…</Text>
        ) : undefined
      }
      ListFooterComponent={
        more ? <Button title="Earlier messages" small kind="ghost" busy={view.loading} onPress={() => older()} style={{ margin: 12 }} /> : undefined
      }
    />
  )
}
