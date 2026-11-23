import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { clicksOf, segments } from "@huntaway/a2ui"
import { olderPage, threadAtom, threadPreviewAtom } from "@huntaway/client"
import type { Task } from "@huntaway/contracts"
import { useMemo, useRef, useState } from "react"
import { ActivityIndicator, FlatList, Pressable, Text, View } from "react-native"
import { foldTools, type Shown, shortToolName, threadRows, type ToolRow, toolsSummary } from "../logic/thread"
import { openPage } from "../state/open"
import { colors, radius, space, tint } from "../theme"
import { Markdown } from "./markdown"
import { RequestCard } from "./requests"
import { Button, Empty, ErrorText, Icon, IconButton, s } from "./ui"

// A task's thread on the phone: @huntaway/client's `threadAtom` (a window of its last items, followed live, older pages
// on request) drawn as rows, newest at the bottom, with the reply being written (`threadPreviewAtom`) under them as
// plain text: parsing it as Markdown again for each token would take longer the longer it got. HE-99: a run of tool
// calls is one line that opens, a published document is a card that opens it, and a button comes back to the latest.

const TOOL_COLOR: Readonly<Record<string, string>> = {
  pending: colors.faint,
  running: colors.blue,
  completed: colors.muted,
  failed: colors.red,
  denied: colors.red,
  cancelled: colors.faint,
}

function ToolLine({ call }: { readonly call: ToolRow }) {
  return (
    <View style={[s.row, { paddingVertical: 3 }]}>
      <Text style={{ color: TOOL_COLOR[call.status] ?? colors.faint, fontSize: 13, fontWeight: "600" }}>{shortToolName(call.name)}</Text>
      <Text style={[s.faint, { flex: 1, fontSize: 13 }]} numberOfLines={1}>
        {call.summary}
      </Text>
    </View>
  )
}

const TOOLS_BOX = {
  marginHorizontal: space.md,
  marginVertical: 3,
  borderRadius: radius.sm,
  backgroundColor: colors.panel,
  borderWidth: 1,
  borderColor: colors.line,
} as const

/** A run of tool calls: how many and the last one, opening to every one of them. */
function Tools({ calls, open, onToggle }: { readonly calls: ReadonlyArray<ToolRow>; readonly open: boolean; readonly onToggle: () => void }) {
  const { label, running, failed } = toolsSummary(calls)
  const last = calls.at(-1)
  const mark = running ? (
    <ActivityIndicator size="small" color={colors.blue} />
  ) : (
    <Icon name="construct-outline" size={15} color={failed > 0 ? colors.red : colors.faint} />
  )
  // One call alone is its own line: there is nothing to open.
  if (calls.length === 1 && last !== undefined)
    return (
      <View style={[s.row, TOOLS_BOX, { minHeight: 40, paddingHorizontal: space.md }]}>
        {mark}
        <View style={{ flex: 1 }}>
          <ToolLine call={last} />
        </View>
      </View>
    )
  return (
    <View style={TOOLS_BOX}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={({ pressed }) => [s.row, { minHeight: 40, paddingHorizontal: space.md }, pressed && s.pressed]}
      >
        {mark}
        <Text style={{ color: failed > 0 ? colors.red : colors.muted, fontSize: 13, fontWeight: "600" }}>{label}</Text>
        <Text style={[s.faint, { flex: 1, fontSize: 13 }]} numberOfLines={1}>
          {open || last === undefined ? "" : `${shortToolName(last.name)} ${last.summary}`}
        </Text>
        <Icon name={open ? "chevron-up" : "chevron-down"} size={14} color={colors.faint} />
      </Pressable>
      {open && (
        <View style={{ paddingHorizontal: space.md, paddingBottom: space.sm, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 6 }}>
          {calls.map((call) => (
            <ToolLine key={call.key} call={call} />
          ))}
        </View>
      )}
    </View>
  )
}

function RowView({
  row,
  host,
  taskId,
  open,
  onToggle,
}: {
  readonly row: Shown
  readonly host: string
  readonly taskId: string
  readonly open: boolean
  readonly onToggle: (key: string) => void
}) {
  switch (row.type) {
    case "user":
      return (
        <View
          style={{
            alignSelf: "flex-end",
            maxWidth: "86%",
            marginHorizontal: space.md,
            marginVertical: 6,
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderRadius: 18,
            borderBottomRightRadius: 6,
            backgroundColor: tint(colors.accent, 0.22),
          }}
        >
          <Text style={[s.body, { fontSize: 16, lineHeight: 22 }]} selectable>
            {userText(row.text)}
          </Text>
        </View>
      )
    case "text":
      return (
        <View style={{ paddingHorizontal: space.lg, paddingVertical: 6 }}>
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
    case "tools":
      return <Tools calls={row.calls} open={open} onToggle={() => onToggle(row.key)} />
    case "doc":
      return (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Document ${row.doc.slug}`}
          onPress={() => openPage(row.doc.page)}
          style={({ pressed }) => [s.card, s.row, { borderColor: tint(colors.accent, 0.5) }, pressed && { backgroundColor: colors.panel2 }]}
        >
          <Icon name="document-text" size={22} color={colors.accent} />
          <View style={{ flex: 1 }}>
            <Text style={s.title} numberOfLines={1}>
              {row.doc.slug}
            </Text>
            <Text style={s.faint}>{row.doc.version === null ? "Document" : `Document · version ${row.doc.version}`}</Text>
          </View>
          <Icon name="chevron-forward" size={16} color={colors.faint} />
        </Pressable>
      )
    case "notice":
      return (
        <Text
          numberOfLines={4}
          style={[
            s.faint,
            {
              paddingHorizontal: space.lg,
              paddingVertical: 4,
              color: row.level === "error" ? colors.red : row.level === "warning" ? colors.amber : colors.faint,
            },
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
        <View style={[s.card, s.row, { borderColor: tint(colors.red, 0.5), alignItems: "flex-start" }]}>
          <Icon name="alert-circle" size={18} color={colors.red} />
          <View style={{ flex: 1 }}>
            <ErrorText>{row.text}</ErrorText>
          </View>
        </View>
      )
    case "request":
      return <RequestCard host={host} taskId={taskId} request={row.request} />
  }
  return null
}

/** How far up the thread the reader is before the way back to its latest shows. */
const AWAY = 500

export function ThreadView({ host, task, emptyTitle }: { readonly host: string; readonly task: Task; readonly emptyTitle?: string }) {
  const ref = { host_id: host, task_id: task.id }
  const view = useAtomValue(threadAtom(ref))
  const preview = useAtomValue(threadPreviewAtom(ref))
  const older = useAtomSet(olderPage(ref))
  const list = useRef<FlatList<Shown>>(null)
  const [opened, setOpened] = useState<ReadonlyArray<string>>([])
  const [away, setAway] = useState(false)
  // Newest first, for the inverted list.
  const rows = useMemo(() => (view.snap === null ? [] : foldTools(threadRows(view.snap)).toReversed()), [view.snap])
  if (view.failed !== null) return <Empty icon="alert-circle-outline" title={view.failed} />
  if (view.snap === null) return <ActivityIndicator style={{ marginTop: 32 }} color={colors.accent} />
  const more = (view.snap.start ?? 0) > 0
  const toggle = (key: string) => setOpened((was) => (was.includes(key) ? was.filter((k) => k !== key) : [...was, key]))
  return (
    <View style={{ flex: 1 }}>
      <FlatList
        ref={list}
        inverted
        data={rows}
        extraData={opened}
        keyExtractor={(row) => row.key}
        renderItem={({ item }) => <RowView row={item} host={host} taskId={task.id} open={opened.includes(item.key)} onToggle={toggle} />}
        // With nothing in it, what it says sits in the middle, not at the bottom (where an inverted list starts).
        contentContainerStyle={[{ paddingVertical: space.sm, flexGrow: 1 }, rows.length === 0 && { justifyContent: "center" }]}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={100}
        onScroll={(event) => {
          const far = event.nativeEvent.contentOffset.y > AWAY
          if (far !== away) setAway(far)
        }}
        ListEmptyComponent={
          // Drawn upside down in an inverted list unless turned back.
          <View style={{ transform: [{ scaleY: -1 }] }}>
            <Empty icon="chatbubbles-outline" title={task.running ? "The agent is starting…" : (emptyTitle ?? "No messages yet.")} />
          </View>
        }
        ListHeaderComponent={
          preview !== null && preview.text !== "" ? (
            <View style={{ paddingHorizontal: space.lg, paddingVertical: 6, gap: 4 }}>
              <Text style={[s.body, { fontSize: 16, lineHeight: 23 }]}>{preview.text}</Text>
              <ActivityIndicator size="small" color={colors.accent} style={{ alignSelf: "flex-start" }} />
            </View>
          ) : task.running && task.background_work?.idle !== true && task.status !== "needs_attention" ? (
            <View style={[s.row, { paddingHorizontal: space.lg, paddingVertical: space.sm }]}>
              <ActivityIndicator size="small" color={colors.blue} />
              <Text style={s.faint}>The agent is working…</Text>
            </View>
          ) : undefined
        }
        ListFooterComponent={
          more ? (
            <Button title="Earlier messages" small kind="ghost" icon="arrow-up" busy={view.loading} onPress={() => older()} style={{ margin: space.md }} />
          ) : undefined
        }
      />
      {away && (
        <IconButton
          icon="arrow-down"
          label="Jump to the latest"
          size={20}
          onPress={() => list.current?.scrollToOffset({ offset: 0, animated: true })}
          style={{
            position: "absolute",
            right: space.md,
            bottom: space.md,
            width: 40,
            height: 40,
            backgroundColor: colors.raised,
            borderWidth: 1,
            borderColor: colors.lineStrong,
          }}
        />
      )}
    </View>
  )
}

/** A user's message as the phone shows it: a click on an interactive reply (HE-77) as its line, with any other text. */
function userText(text: string): string {
  const found = clicksOf(text)
  return found === null ? text : [...found.clicks.map((c) => c.label || c.action.name), found.rest].filter((t) => t !== "").join("\n\n")
}
