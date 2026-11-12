// How the prompt cards answer (the old promptAnswers.ts): with the host's `permissions.answer` (the old `POST
// /permissions/{id}`), whose answer is not put on the board: the thread's request, written again from the prompt, is
// what the card then draws. A card runs it as its own action (`useAction`), which shows it waiting and why it failed.
import { mutate } from "@huntaway/client"
import { RequestId, type PermissionAnswer } from "@huntaway/contracts"

/** Answers prompt `id` on host `hostId`: fails with the host's tagged error. */
export const answerPrompt = (hostId: string, id: string, answer: PermissionAnswer) => mutate("permissions.answer", hostId, { id: RequestId.make(id), answer })
