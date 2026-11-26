import { type HostTask, unreadInReview } from "@huntaway/client"
import { Pressable, Text, View } from "react-native"
import { agentNote } from "../logic/tasks"
import { ago } from "../logic/time"
import { openTask } from "../state/open"
import { colors, STATUS_COLOR } from "../theme"
import { Pill, s } from "./ui"

// A task in a list (HE-99): its key, where it is, when it last moved, its title, and what is going on with it in a
// glance: its agent, a pull request's checks, a review nobody has opened, why it needs attention.

const AGENT_COLOR = { working: colors.blue, waiting: colors.muted, idle: colors.muted, queued: colors.faint } as const

export function TaskCard({ task: t, project, now }: { readonly task: HostTask; readonly project?: string | undefined; readonly now: number }) {
  const agent = agentNote(t)
  const fresh = unreadInReview(t)
  const checks = t.pr_checks?.outcome
  const reason = t.status === "needs_attention" ? t.attention_reason : null
  return (
    <Pressable
      style={({ pressed }) => [s.card, fresh && { borderColor: STATUS_COLOR.in_review }, pressed && { backgroundColor: colors.panel2 }]}
      accessibilityRole="link"
      accessibilityLabel={`${t.key} ${t.title}`}
      onPress={() => openTask(t.host_id, t.id)}
    >
      <View style={s.row}>
        <View style={[s.dot, { backgroundColor: STATUS_COLOR[t.status] }]} />
        <Text style={[s.faint, { flex: 1 }]} numberOfLines={1}>
          {project === undefined ? t.key : `${t.key} · ${project}`}
        </Text>
        <Text style={s.faint}>{ago(t.last_activity_at, now)}</Text>
      </View>
      <Text style={s.title} numberOfLines={2}>
        {t.title}
      </Text>
      {reason !== null && (
        <Text style={[s.muted, { color: colors.amber }]} numberOfLines={2}>
          {reason}
        </Text>
      )}
      {(agent !== null || fresh || checks === "failed" || checks === "pending") && (
        <View style={[s.wrap, { gap: 6, paddingTop: 2 }]}>
          {agent !== null && <Pill label={agent.label} color={AGENT_COLOR[agent.state]} busy={agent.state === "working"} icon="time-outline" />}
          {fresh && <Pill label="New in review" color={STATUS_COLOR.in_review} icon="eye-outline" />}
          {checks === "failed" && <Pill label="Checks failed" color={colors.red} icon="close-circle-outline" />}
          {checks === "pending" && <Pill label="Checks running" color={colors.muted} icon="ellipse-outline" />}
        </View>
      )}
    </Pressable>
  )
}
