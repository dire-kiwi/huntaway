// Answering what an agent waits on, in place: a permission prompt (Allow or Deny; the questions of Claude's
// AskUserQuestion and of Codex, which come as a request_user_input prompt, by picking or typing answers) and a question asked with request_user_input (pick options or type an answer).
import { takesTypedAnswer, type Client, type PermissionReply } from "@huntaway/client";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { colors } from "./theme";
import { Button, ErrorText, s } from "./ui";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** The tools whose prompts are questions for the user, not requests for permission (server: permissions::is_question). */
const QUESTION_TOOLS = ["AskUserQuestion", "request_user_input"];
export const isQuestionTool = (tool: string) => QUESTION_TOOLS.includes(tool);

/** One line saying what a tool call does, from its input. */
export function toolSummary(input: Any): string {
  if (input == null || typeof input !== "object") return String(input ?? "");
  const first = (...keys: string[]) => keys.map((k) => input[k]).find((v) => typeof v === "string" && v.trim());
  const text = first("command", "file_path", "path", "url", "pattern", "query", "description", "prompt", "plan");
  if (text) return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  const json = JSON.stringify(input);
  return json.length > 300 ? `${json.slice(0, 300)}…` : json;
}

/** A question as AskUserQuestion asks it, with Codex's `isOther` (whether it takes an answer of the user's own) and `isSecret`. */
type Asked = {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  takesText: boolean;
  secret: boolean;
};

/**
 * The questions of a question prompt: Claude's AskUserQuestion, or Codex's questions, which come as a prompt for
 * `request_user_input`. Claude's always take a typed answer; Codex says which do, and one without options needs one.
 */
export function askedQuestions(tool: string, input: Any): Asked[] {
  const list = input?.questions;
  if (!Array.isArray(list)) return [];
  const codex = tool === "request_user_input";
  return list
    .filter((q: Any) => q && typeof q === "object")
    .map((q: Any) => {
      const options = (Array.isArray(q.options) ? q.options : [])
        .map((o: Any) => (typeof o === "string" ? { label: o } : { label: String(o?.label ?? ""), description: o?.description || undefined }))
        .filter((o: { label: string }) => o.label);
      return {
        question: String(q.question ?? "") || "(no question)",
        header: typeof q.header === "string" && q.header ? q.header : undefined,
        options,
        multiSelect: q.multiSelect === true,
        takesText: takesTypedAnswer(codex, { isOther: q.isOther, options }),
        secret: q.isSecret === true,
      };
    });
}

/** The answers to a question: with several, the options picked and what's typed; with one, what's typed or else the option. */
export function answerOf(q: Asked, a: Answer): string[] {
  const typed = q.takesText && a.text.trim() ? [a.text.trim()] : [];
  return q.multiSelect ? [...a.picked, ...typed] : typed.length ? typed : a.picked;
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
            style={{
              padding: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: on ? colors.accent : colors.line,
              backgroundColor: on ? "rgba(139,124,246,0.15)" : colors.raised,
            }}
          >
            <Text style={{ color: colors.fg, fontSize: 15 }}>{o.label}</Text>
            {!!o.description && <Text style={s.faint}>{o.description}</Text>}
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * A pending permission prompt with its answers. `onDone` runs once it's answered. A question prompt (AskUserQuestion,
 * or Codex's `request_user_input`) is answered with the user's answers, question by question, rather than allowed.
 */
export function PermissionCard({
  client,
  hostId,
  id,
  tool,
  input,
  onDone,
}: {
  client: Pick<Client, "resolvePermission">;
  hostId: string;
  id: string;
  tool: string;
  input: Any;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const questions = isQuestionTool(tool) ? askedQuestions(tool, input) : [];
  const [drafts, setDrafts] = useState<Answer[]>(() => questions.map(() => ({ picked: [], text: "" })));

  const answer = async (decision: "allow" | "deny", message?: string, reply?: PermissionReply) => {
    setBusy(decision);
    setErr(null);
    try {
      await client.resolvePermission(hostId, id, decision, message, reply);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (questions.length) {
    const answers = questions.map((q, i) => answerOf(q, drafts[i] ?? { picked: [], text: "" }));
    const set = (i: number, f: (a: Answer) => Answer) => setDrafts((all) => all.map((a, j) => (j === i ? f(a) : a)));
    return (
      <View style={{ gap: 10 }}>
        {questions.map((q, i) => (
          <View key={i} style={{ gap: 6 }}>
            <Text style={[s.title, { fontWeight: "500" }]}>
              {q.header ? <Text style={s.faint}>{q.header} · </Text> : null}
              {q.question}
            </Text>
            {q.options.length > 0 && (
              <Options options={q.options} picked={drafts[i]?.picked ?? []} onPick={(label) => set(i, (a) => pickOption(a, label, q.multiSelect))} />
            )}
            {q.takesText && (
              <TextInput
                style={[s.input, { minHeight: 44 }]}
                value={drafts[i]?.text ?? ""}
                onChangeText={(t) => set(i, (a) => typeAnswer(a, t, q.multiSelect))}
                placeholder={q.options.length ? (q.multiSelect ? "Something else too (optional)" : "Or type an answer") : "Your answer"}
                placeholderTextColor={colors.faint}
                accessibilityLabel={`Your answer to: ${q.question}`}
                secureTextEntry={q.secret}
                multiline={!q.secret}
              />
            )}
          </View>
        ))}
        <View style={s.row}>
          <Button
            title={questions.length === 1 ? "Answer" : "Send answers"}
            kind="primary"
            small
            busy={busy === "allow"}
            disabled={answers.some((a) => !a.length)}
            onPress={() => answer("allow", undefined, { answers })}
          />
          <Button title="Dismiss" small busy={busy === "deny"} onPress={() => answer("deny", "The user dismissed these questions without answering them.")} />
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
export function QuestionCard({
  client,
  hostId,
  taskId,
  messageId,
  data,
  onDone,
}: {
  client: Pick<Client, "answerQuestion">;
  hostId: string;
  taskId: string;
  messageId: number;
  data: Any;
  onDone: () => void;
}) {
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
