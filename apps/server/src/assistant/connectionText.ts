import type { QuestionRequest, RequestResolution } from "@huntaway/contracts"

// The assistant's connection cards, their plain parts (HE-28; bot-hq's `request_app_connection`): when the assistant,
// or a thread under it, needs something set up that isn't (Google to start with), it asks with `request_connection`,
// which puts a card in its thread and ends its turn, like a question. The card says what's missing and why the agent
// wants it, and settles once: connected (the user's Check again, or the board's own look every `SWEEP_EVERY`), skipped,
// or a message from the user. The agent is then told to carry on (`connectedText`, `skippedText`).
//
// A connection is a kind with a label and a way to tell whether it's there (`Connections.state`). Another MCP server
// (one switched off for the profile, say) is another kind: a label here and its state there.

/** What the assistant can ask to have connected. */
export const CONNECTION_KINDS = ["google"] as const
export type ConnectionKind = (typeof CONNECTION_KINDS)[number]

/** Each kind as the card and the agent's messages name it. */
export const LABELS: { readonly [K in ConnectionKind]: string } = { google: "Google" }

/** Whether a connection is there for a profile's assistant here, as whom, and if not, why not. */
export interface ConnectionState {
  readonly connected: boolean
  readonly account: string | null
  readonly problem: string | null
}

/** How often the board looks again at the connections its open cards ask for. */
export const SWEEP_EVERY = "30 seconds"

/** The card's one question's id, and the options its resolution records (`answers.q`). */
export const QUESTION_ID = "q"
export const SKIP = "Skip"
export const CONNECTED = "connected"
export const SKIPPED = "skipped"

/** What the agent is told when the connection is made. */
export const connectedText = (kind: ConnectionKind, account: string | null): string =>
  `${LABELS[kind]} is connected now${account === null ? "" : ` (as ${account})`}. Carry on with what you were doing.`

/** What the agent is told when the user skips it. */
export const skippedText = (kind: ConnectionKind): string => `The user skipped connecting ${LABELS[kind]}. Carry on without it.`

/** The attention reason of a thread waiting on a connection card. */
export const attentionOf = (kind: ConnectionKind): string => `Connect ${LABELS[kind]}`

/** What `request_connection` tells the agent when it put a card up. */
export const ASKED =
  "The user is shown a card asking them to connect it, with your reason. End your turn now, saying briefly what you need it for; " +
  "you'll get a message when it's connected (carry on then) or when they skip it (carry on without it)."

/** What it tells the agent when it's there already. */
export const alreadyConnected = (kind: ConnectionKind, account: string | null): string =>
  `${LABELS[kind]} is connected${account === null ? "" : ` as ${account}`}: no card was needed. If one of its tools failed, try it again; ` +
  "if it fails the same way, tell the user what it said."

/** What it tells a routine's run, which nobody is watching: no card, and the report says so. */
export const unattended = (kind: ConnectionKind, problem: string | null): string =>
  `${LABELS[kind]} isn't connected${problem === null ? "" : ` (${problem})`}, and nobody is there to connect it during a routine's run, so no card ` +
  `was put up. Carry on without it, and say in your report that ${LABELS[kind]} isn't connected and that the user can set it up in ` +
  `Settings → Assistant → ${LABELS[kind]}.`

/** The card's request, as it is opened in the thread: a board question (`call_id`) with the connection in its metadata. */
export const connectionRequest = (
  kind: ConnectionKind,
  reason: string,
  problem: string | null,
  callId: string,
): Omit<QuestionRequest, "id" | "resolution"> => ({
  type: "question",
  questions: [{ id: QUESTION_ID, question: attentionOf(kind), options: [{ label: SKIP }], multi_select: false, allow_other: false }],
  metadata: { connection: kind, reason, problem, call_id: callId },
})

/** The connection a card asks for, if the request is one. */
export const connectionOf = (request: { readonly metadata?: Readonly<Record<string, unknown>> | undefined }): ConnectionKind | null => {
  const kind = request.metadata?.["connection"]
  return CONNECTION_KINDS.find((k) => k === kind) ?? null
}

/** A card's resolution once it's connected (as whom) or skipped. */
export const connectedResolution = (account: string | null): RequestResolution => ({
  outcome: "answer",
  answers: account === null ? { [QUESTION_ID]: [CONNECTED] } : { [QUESTION_ID]: [CONNECTED], account: [account] },
  message: account === null ? "Connected" : `Connected as ${account}`,
})
export const skippedResolution: RequestResolution = { outcome: "answer", answers: { [QUESTION_ID]: [SKIPPED] }, message: "Skipped" }
/**
 * A card the conversation moved past without settling it (a routine's message, another agent's `send_to_task`): closed
 * by the board's sweep, unanswered, so it isn't read again. Its message starts as a question's expiry does, which the web
 * app shows as not answered.
 */
export const movedOnResolution: RequestResolution = { outcome: "cancel", message: "Expired: the conversation moved on before it was settled" }
