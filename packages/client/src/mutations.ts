import { Atom } from "effect/reactivity"
import { callRpc, type CallError, type Methods } from "./rpc.ts"

/** What a mutation is run with: the host to call and the method's payload. */
export interface MutationArg<M extends keyof Methods> {
  readonly host: string
  readonly payload: Methods[M]["payload"]
}

/** A method of a host as an `AtomResultFn` a component runs with `useAtomSet` (calls of it run side by side). */
export type Mutation<M extends keyof Methods> = Atom.AtomResultFn<MutationArg<M>, Methods[M]["success"], CallError<M>>

const mutation = <M extends keyof Methods>(method: M): Mutation<M> =>
  Atom.fn<MutationArg<M>>()((arg) => callRpc(arg.host, method, arg.payload), { concurrent: true })

/**
 * The calls that change a host's board (docs/plan/09-frontend.md, Queries, mutations, invalidation). A mutation does
 * not write its answer into the board; the event that follows it does. Moving, reordering and starring a task, which
 * show at once, are `optimisticMove`.
 */
export const mutations = {
  tasks: {
    create: mutation("tasks.create"),
    update: mutation("tasks.update"),
    delete: mutation("tasks.delete"),
    // A composer's sends and unqueues are `sendMessage` and `unqueueMessage` (thread/send.ts), which keep its draft.
    send: mutation("tasks.send"),
    stop: mutation("tasks.stop"),
    dropQueued: mutation("tasks.dropQueued"),
    // 4.8: where the tasks merging into a closed or deleted task go now, a whole stack's merge, a stack's title.
    mergeTarget: mutation("tasks.mergeTarget"),
    mergeStack: mutation("tasks.mergeStack"),
    updateStack: mutation("tasks.updateStack"),
  },
  projects: { create: mutation("projects.create"), update: mutation("projects.update"), delete: mutation("projects.delete") },
  profiles: { create: mutation("profiles.create"), update: mutation("profiles.update"), delete: mutation("profiles.delete") },
  configs: { create: mutation("configs.create"), update: mutation("configs.update"), delete: mutation("configs.delete") },
  pens: { create: mutation("pens.create"), update: mutation("pens.update"), delete: mutation("pens.delete") },
  host: { updateSettings: mutation("host.updateSettings") },
  // A prompt's answer: the request and the thread's card change with the events that follow.
  permissions: { answer: mutation("permissions.answer") },
  // A board question's answer, sent to the agent as the user's message.
  threads: { answerQuestion: mutation("threads.answerQuestion") },
  // Rewinding a task to before a turn, and keeping its conversation as it is: the task and its turns change with the
  // events that follow.
  checkpoints: { rewind: mutation("checkpoints.rewind"), cancelRewind: mutation("checkpoints.cancelRewind") },
  // 6.6: a project's workflows, and running and stopping them on a task: the lists change with the events that follow.
  workflows: {
    create: mutation("workflows.create"),
    update: mutation("workflows.update"),
    delete: mutation("workflows.delete"),
    run: mutation("workflows.run"),
    stopRun: mutation("workflows.stopRun"),
  },
} as const
