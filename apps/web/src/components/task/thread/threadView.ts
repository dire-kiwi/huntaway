// How a task's thread is drawn (the old src/threadView.ts, itemThreads.ts and deltas.ts): from its items, as
// @huntaway/client's `threadAtom` follows them (a window of the last ones, older pages loaded on the way up), made into
// rows by itemModel.ts. The reply being written comes apart (`threadPreviewAtom`) and is drawn once per animation frame.
// What the prompt cards send (the thread's `respond` command) comes with answering them (3.3).
import { RegistryContext, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { olderPage, reloadThread, threadAtom, threadPreviewAtom, type ThreadRef, type ThreadView } from "@huntaway/client"
import { useCallback, useContext, useEffect, useState } from "react"
import { itemModel } from "./itemModel"
import type { ThreadModel } from "./threadModel"

/** The thread of a task (by its host and id). */
export const threadRef = (task: { readonly host_id: string; readonly id: string }): ThreadRef => ({ host_id: task.host_id, task_id: task.id })

/** A task's thread, followed while the component is mounted (and for ten seconds after the last one goes). */
export function useThreadView(task: { readonly host_id: string; readonly id: string }): ThreadView {
  return useAtomValue(threadAtom(threadRef(task)))
}

const EMPTY = { items: [], requests: [] }

/** The rows of a task's thread, built from its items: what the thread, the Agents pill and the context view draw. */
export function useThreadModel(task: { readonly host_id: string; readonly id: string; readonly running: boolean }): ThreadModel {
  const view = useThreadView(task)
  return itemModel(task.id, view.snap ?? EMPTY, task.running)
}

/** Loads the page of the thread before what it shows: a promise that rejects if it couldn't. */
export function useLoadOlder(task: { readonly host_id: string; readonly id: string }): () => Promise<void> {
  const load = useAtomSet(olderPage(threadRef(task)), { mode: "promise" })
  return useCallback(() => load(undefined), [load])
}

/** Subscribes to a thread that failed again from scratch. */
export function useReloadThread(task: { readonly host_id: string; readonly id: string }): () => void {
  return useAtomRefresh(reloadThread(threadRef(task)))
}

/**
 * The reply being written in a task's thread, as streamed so far: taken once per animation frame, so a burst of tokens
 * lays the text out once. Undefined when there is none.
 */
export function usePreviewText(task: { readonly host_id: string; readonly id: string }): string | undefined {
  const registry = useContext(RegistryContext)
  const atom = threadPreviewAtom(threadRef(task))
  const [text, setText] = useState(() => registry.get(atom)?.text)
  useEffect(() => {
    let frame: number | null = null
    const take = () => {
      frame = null
      setText(registry.get(atom)?.text)
    }
    const cancel = registry.subscribe(atom, () => (frame ??= requestAnimationFrame(take)), { immediate: true })
    return () => {
      cancel()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [registry, atom])
  return text
}
