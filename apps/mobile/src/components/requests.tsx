import { mutate } from "@huntaway/client"
import { type PermissionAnswer, RequestId, TaskId, type ThreadRequest } from "@huntaway/contracts"
import { useState } from "react"
import { Text, TextInput, View } from "react-native"
import { inputText, isBoardQuestion, isOpen, shortToolName } from "../logic/thread"
import { useAction } from "../state/action"
import { colors, space, tint } from "../theme"
import { Markdown } from "./markdown"
import { Button, Chip, ErrorText, Icon, s } from "./ui"

// The cards of a thread's requests (the old app's prompts.tsx, on the thread's own requests): a prompt answered Allow
// or Deny, the agent's questions (options, several at once, a typed answer), a plan approved or sent back, and the
// board's own question, whose answer goes as the user's message. An answered one shows in one line.

const DISMISSED = "The user dismissed these questions without answering them."

/** What a request came to, in a few words. */
const outcomeText = (r: ThreadRequest): string => {
  const o = r.resolution?.outcome
  if (o === "allow") return r.type === "plan" ? "Plan approved" : "Allowed"
  if (o === "deny") return r.type === "plan" ? "Sent back" : "Denied"
  if (o === "answer") return "Answered"
  return "Dismissed"
}

const requestTitle = (r: ThreadRequest): string => {
  if (r.type === "permission") return `Allow ${shortToolName(r.name)}?`
  if (r.type === "plan") return "The agent has a plan"
  return r.questions.length === 1 ? (r.questions[0]?.header ?? "A question") : `${r.questions.length} questions`
}

export function RequestCard({ host, taskId, request }: { readonly host: string; readonly taskId: string; readonly request: ThreadRequest }) {
  if (!isOpen(request)) {
    const refused = request.resolution?.outcome === "deny"
    return (
      <View style={[s.row, { paddingHorizontal: space.lg, paddingVertical: 4 }]}>
        <Icon name={refused ? "close-circle-outline" : "checkmark-circle-outline"} size={14} color={colors.faint} />
        <Text style={[s.faint, { flex: 1, fontSize: 13 }]} numberOfLines={1}>
          {requestTitle(request)} · {outcomeText(request)}
        </Text>
      </View>
    )
  }
  return (
    <View style={[s.card, { borderColor: tint(colors.amber, 0.6), padding: space.lg, gap: space.sm }]}>
      <View style={s.row}>
        <Icon
          name={request.type === "permission" ? "shield-half-outline" : request.type === "plan" ? "map-outline" : "help-circle-outline"}
          size={18}
          color={colors.amber}
        />
        <Text style={[s.title, { flex: 1 }]}>{requestTitle(request)}</Text>
      </View>
      {request.type === "permission" && <PermissionBody host={host} request={request} />}
      {request.type === "plan" && <PlanBody host={host} request={request} />}
      {request.type === "question" && <QuestionBody host={host} taskId={taskId} request={request} />}
    </View>
  )
}

/** Answers prompt `id` on `host`. */
const answer = (host: string, id: string, a: PermissionAnswer) => mutate("permissions.answer", host, { id: RequestId.make(id), answer: a })

function PermissionBody({ host, request }: { readonly host: string; readonly request: Extract<ThreadRequest, { type: "permission" }> }) {
  const [{ busy, error }, run] = useAction()
  // What it would do: its command, file or address, else the agent's own words for it.
  const said = inputText(request.input) || (request.title ?? "")
  return (
    <>
      {said !== "" && (
        <Text
          style={[s.muted, { fontFamily: "monospace", fontSize: 13, padding: space.sm, borderRadius: 8, backgroundColor: colors.raised }]}
          numberOfLines={8}
        >
          {said}
        </Text>
      )}
      <View style={s.row}>
        <Button
          title="Allow"
          kind="primary"
          icon="checkmark"
          busy={busy}
          style={{ flex: 1 }}
          onPress={() => run(answer(host, request.id, { decision: "allow" }))}
        />
        <Button
          title="Deny"
          kind="danger"
          icon="close"
          disabled={busy}
          style={{ flex: 1 }}
          onPress={() => run(answer(host, request.id, { decision: "deny" }))}
        />
      </View>
      <Button
        title="Always allow in this thread"
        kind="ghost"
        small
        disabled={busy}
        onPress={() => run(answer(host, request.id, { decision: "allow_always" }))}
      />
      {error !== null && <ErrorText>{error}</ErrorText>}
    </>
  )
}

function PlanBody({ host, request }: { readonly host: string; readonly request: Extract<ThreadRequest, { type: "plan" }> }) {
  const [{ busy, error }, run] = useAction()
  const [feedback, setFeedback] = useState<string | null>(null)
  return (
    <>
      <Markdown text={request.plan} />
      {feedback === null ? (
        <View style={s.wrap}>
          <Button
            title="Approve"
            kind="primary"
            icon="checkmark"
            busy={busy}
            onPress={() => run(answer(host, request.id, { decision: "allow", mode: "default" }))}
          />
          <Button title="Approve, accept edits" disabled={busy} onPress={() => run(answer(host, request.id, { decision: "allow", mode: "acceptEdits" }))} />
          <Button title="Keep planning" kind="ghost" disabled={busy} onPress={() => setFeedback("")} />
        </View>
      ) : (
        <>
          <TextInput
            style={s.input}
            placeholder="What should change?"
            placeholderTextColor={colors.faint}
            value={feedback}
            onChangeText={setFeedback}
            multiline
          />
          <View style={s.row}>
            <Button
              title="Send back"
              kind="primary"
              busy={busy}
              onPress={() => run(answer(host, request.id, { decision: "deny", feedback: feedback.trim() }))}
            />
            <Button title="Cancel" kind="ghost" onPress={() => setFeedback(null)} />
          </View>
        </>
      )}
      {error !== null && <ErrorText>{error}</ErrorText>}
    </>
  )
}

function QuestionBody({
  host,
  taskId,
  request,
}: {
  readonly host: string
  readonly taskId: string
  readonly request: Extract<ThreadRequest, { type: "question" }>
}) {
  const [{ busy, error }, run] = useAction()
  const questions = request.questions
  const [picked, setPicked] = useState<ReadonlyArray<ReadonlyArray<string>>>(() => questions.map(() => []))
  const [typed, setTyped] = useState<ReadonlyArray<string>>(() => questions.map(() => ""))
  const board = isBoardQuestion(request)
  const answers = questions.map((_, i) => {
    const text = typed[i]?.trim() ?? ""
    return [...(picked[i] ?? []), ...(text === "" ? [] : [text])]
  })
  const send = (list: ReadonlyArray<ReadonlyArray<string>>): void => {
    if (board) {
      const text = typed[0]?.trim() ?? ""
      const choices = (list[0] ?? []).filter((c) => c !== text)
      run(mutate("threads.answerQuestion", host, { task_id: TaskId.make(taskId), request_id: request.id, choices, text: text === "" ? null : text }))
    } else run(answer(host, request.id, { decision: "allow", answers: list.map((a) => [...a]) }))
  }
  const single = questions.length === 1 && questions[0]?.multi_select !== true && (questions[0]?.options?.length ?? 0) > 0
  const pick = (qi: number, label: string, multi: boolean): void => {
    if (single && !multi) send([[label]])
    else setPicked((was) => was.map((p, i) => (i !== qi ? p : multi ? (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]) : [label])))
  }
  return (
    <>
      {questions.map((q, qi) => {
        const options = q.options ?? []
        const takesText = options.length === 0 || q.allow_other === true
        return (
          <View key={q.id} style={{ gap: 6 }}>
            <Text style={s.body}>{q.question}</Text>
            {options.length > 0 && (
              <View style={s.wrap}>
                {options.map((o) => (
                  <Chip
                    key={o.label}
                    label={o.label}
                    selected={picked[qi]?.includes(o.label) ?? false}
                    onPress={() => pick(qi, o.label, q.multi_select === true)}
                  />
                ))}
              </View>
            )}
            {takesText && (
              <TextInput
                style={s.input}
                placeholder={options.length === 0 ? "Your answer" : "Or type an answer"}
                placeholderTextColor={colors.faint}
                secureTextEntry={q.secret === true}
                value={typed[qi] ?? ""}
                onChangeText={(t) => setTyped((was) => was.map((x, i) => (i === qi ? t : x)))}
              />
            )}
          </View>
        )
      })}
      <View style={s.row}>
        <Button title="Send" kind="primary" icon="arrow-up" busy={busy} disabled={answers.some((a) => a.length === 0)} onPress={() => send(answers)} />
        {!board && (
          <Button title="Dismiss" kind="ghost" disabled={busy} onPress={() => run(answer(host, request.id, { decision: "deny", message: DISMISSED }))} />
        )}
      </View>
      {error !== null && <ErrorText>{error}</ErrorText>}
    </>
  )
}
