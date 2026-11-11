// How the prompt cards answer (the old promptAnswers.ts): with the host's `permissions.answer` (the old `POST
// /permissions/{id}`), whose answer is not put on the board: the thread's request, written again from the prompt, is
// what the card then draws. The thread's own `respond` command waits for `threads.command`, which no one serves yet.
import { useAtomSet } from "@effect/atom-react"
import { mutations } from "@huntaway/client"
import { RequestId, type PermissionAnswer } from "@huntaway/contracts"
import { useCallback } from "react"

/** Answers prompt `id` on host `hostId`: a promise that rejects with the host's tagged error. */
export type PromptAnswerer = (id: string, answer: PermissionAnswer) => Promise<unknown>

export function usePromptAnswers(hostId: string): PromptAnswerer {
  const answer = useAtomSet(mutations.permissions.answer, { mode: "promise" })
  return useCallback((id, a) => answer({ host: hostId, payload: { id: RequestId.make(id), answer: a } }), [answer, hostId])
}
