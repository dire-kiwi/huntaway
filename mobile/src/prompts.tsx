// Answering what an agent waits on, in place: a permission prompt (Allow or Deny; AskUserQuestion's questions by
// picking answers) and a question asked with request_user_input (pick options or type an answer).
import type { Client, PermissionReply } from "@huntaway/client";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { colors } from "./theme";
import { Button, ErrorText, s } from "./ui";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const QUESTION_TOOLS = ["AskUserQuestion", "request_user_input"];

/** One line saying what a tool call does, from its input. */
export function toolSummary(input: Any): string {
  if (input == null || typeof input !== "object") return String(input ?? "");
  const first = (...keys: string[]) => keys.map((k) => input[k]).find((v) => typeof v === "string" && v.trim());
  const text = first("command", "file_path", "path", "url", "pattern", "query", "description", "prompt", "plan");
  if (text) return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  const json = JSON.stringify(input);
  return json.length > 300 ? `${json.slice(0, 300)}…` : json;
}

type Asked = { question: string; options: { label: string; description?: string }[]; multiSelect?: boolean };

function askedQuestions(input: Any): Asked[] {
  const list = input?.questions;
  if (!Array.isArray(list)) return [];
  return list.map((q: Any) => ({
    question: String(q?.question ?? ""),
    options: (Array.isArray(q?.options) ? q.options : []).map((o: Any) => (typeof o === "string" ? { label: o } : { label: String(o?.label ?? ""), description: o?.description })),
    multiSelect: q?.multiSelect === true,
  }));
}

function Options({ options, picked, onPick }: { options: { label: string; description?: string }[]; picked: string[]; onPick: (label: string) => void }) {
  return (
    <View style={{ gap: 6 }}>
      {options.map((o) => {
        const on = picked.includes(o.label);
        return (
          <Pressable
            key={o.label}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onPick(o.label)}
            style={{ padding: 10, borderRadius: 8, borderWidth: 1, borderColor: on ? colors.accent : colors.line, backgroundColor: on ? "rgba(139,124,246,0.15)" : colors.raised }}
          >
            <Text style={{ color: colors.fg, fontSize: 15 }}>{o.label}</Text>
            {!!o.description && <Text style={s.faint}>{o.description}</Text>}
          </Pressable>
        );
      })}
    </View>
  );
}

/** A pending permission prompt with its answers. `onDone` runs once it's answered. */
export function PermissionCard({ client, hostId, id, tool, input, onDone }: { client: Client; hostId: string; id: string; tool: string; input: Any; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const questions = tool === "AskUserQuestion" ? askedQuestions(input) : [];
  const [answers, setAnswers] = useState<string[][]>(() => questions.map(() => []));

  const answer = async (decision: "allow" | "deny", reply?: PermissionReply) => {
    setBusy(decision);
    setErr(null);
    try {
      await client.resolvePermission(hostId, id, decision, undefined, reply);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (questions.length) {
    return (
      <View style={{ gap: 10 }}>
        {questions.map((q, i) => (
          <View key={i} style={{ gap: 6 }}>
            <Text style={[s.title, { fontWeight: "500" }]}>{q.question}</Text>
            <Options
              options={q.options}
              picked={answers[i] ?? []}
              onPick={(label) =>
                setAnswers((a) => a.map((x, j) => (j !== i ? x : q.multiSelect ? (x.includes(label) ? x.filter((l) => l !== label) : [...x, label]) : [label])))
              }
            />
          </View>
        ))}
        <View style={s.row}>
          <Button title="Send answers" kind="primary" small busy={busy === "allow"} disabled={answers.some((a) => !a.length)} onPress={() => answer("allow", { answers })} />
          <Button title="Decline" small busy={busy === "deny"} onPress={() => answer("deny")} />
        </View>
        {err && <ErrorText>{err}</ErrorText>}
      </View>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      <Text style={s.muted}>
        <Text style={{ color: colors.amber, fontWeight: "700" }}>{tool}</Text> {toolSummary(input)}
      </Text>
      <View style={s.row}>
        <Button title="Allow" kind="primary" small busy={busy === "allow"} onPress={() => answer("allow")} />
        <Button title="Deny" kind="danger" small busy={busy === "deny"} onPress={() => answer("deny")} />
      </View>
      {err && <ErrorText>{err}</ErrorText>}
    </View>
  );
}

/** An answer to a question being made: the options picked, and what's typed. */
export type Answer = { picked: string[]; text: string };

/**
 * Picking `label`. Several options can be picked (and something typed besides) only where the question takes several
 * answers; otherwise an option and a typed answer are one or the other (the board takes one answer), and picking the
 * picked option again unpicks it.
 */
export function pickOption(a: Answer, label: string, multi: boolean): Answer {
  if (multi) return { ...a, picked: a.picked.includes(label) ? a.picked.filter((l) => l !== label) : [...a.picked, label] };
  return a.picked.includes(label) ? { ...a, picked: [] } : { picked: [label], text: "" };
}

/** Typing `text`: for a question with one answer, it takes the place of a picked option. */
export function typeAnswer(a: Answer, text: string, multi: boolean): Answer {
  return { picked: multi || !text.trim() ? a.picked : [], text };
}

/** A question asked with request_user_input: its options, and a typed answer if it takes one. */
export function QuestionCard({ client, hostId, taskId, messageId, data, onDone }: { client: Pick<Client, "answerQuestion">; hostId: string; taskId: string; messageId: number; data: Any; onDone: () => void }) {
  const options: { label: string; description?: string }[] = Array.isArray(data?.options) ? data.options : [];
  const multi = data?.multi_select === true;
  const allowOther = data?.allow_other !== false;
  const [answer, setAnswer] = useState<Answer>({ picked: [], text: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const send = async (a: Answer) => {
    setBusy(true);
    setErr(null);
    try {
      await client.answerQuestion(hostId, taskId, messageId, { choices: a.picked, text: a.text.trim() || null });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 8 }}>
      <Text style={[s.title, { fontWeight: "500" }]}>{String(data?.question ?? "")}</Text>
      {options.length > 0 && (
        <Options
          options={options}
          picked={answer.picked}
          onPick={(label) => {
            // With nothing else to give, a tap is the answer.
            if (!multi && !allowOther) void send({ picked: [label], text: "" });
            else setAnswer((a) => pickOption(a, label, multi));
          }}
        />
      )}
      {allowOther && (
        <TextInput
          style={[s.input, { minHeight: 44 }]}
          value={answer.text}
          onChangeText={(t) => setAnswer((a) => typeAnswer(a, t, multi))}
          placeholder={options.length ? "Or type an answer" : "Your answer"}
          placeholderTextColor={colors.faint}
          accessibilityLabel="Your answer"
          multiline
        />
      )}
      {(multi || allowOther) && (
        <Button title="Answer" kind="primary" small busy={busy} disabled={!answer.picked.length && !answer.text.trim()} onPress={() => send(answer)} />
      )}
      {err && <ErrorText>{err}</ErrorText>}
    </View>
  );
}

export const isQuestionTool = (tool: string) => QUESTION_TOOLS.includes(tool);
