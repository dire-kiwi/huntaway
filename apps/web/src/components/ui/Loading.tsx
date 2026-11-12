import { Cause, Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { Loader2 } from "lucide-react"
import type { ReactNode } from "react"
import { errorText } from "../../state/mutation"
import { ErrorBox } from "./Modal"

// A query's result as the components draw it (docs/plan/09-frontend.md, step 2): the spinner while it is first read,
// the error box when it failed, and what it read (kept while it is read again).

/** Why a result failed, for showing; null while it hasn't (an interruption is not a failure). */
export function resultError(result: AsyncResult.AsyncResult<unknown, unknown>): string | null {
  if (!AsyncResult.isFailure(result) || Cause.hasInterruptsOnly(result.cause)) return null
  return errorText(Cause.squash(result.cause))
}

/** What a result has read, the last value while it is read again or after it failed; undefined before the first. */
export function resultValue<A>(result: AsyncResult.AsyncResult<A, unknown>): A | undefined {
  return Option.getOrUndefined(AsyncResult.value(result))
}

const SPINNER = <Loader2 size={13} className="animate-spin" />
const errorBox = (message: string): ReactNode => <ErrorBox>{message}</ErrorBox>

/**
 * `<Loading result={useAtomValue(query(…))}>{(value) => …}</Loading>`: `waiting` (a spinner) until the first answer,
 * `failed` (an error box) when it failed, else `children` with what it read, also while it's read again.
 */
export function Loading<A, E>({
  result,
  children,
  waiting = SPINNER,
  failed = errorBox,
}: {
  readonly result: AsyncResult.AsyncResult<A, E>
  readonly children: (value: A, refreshing: boolean) => ReactNode
  readonly waiting?: ReactNode
  readonly failed?: (message: string) => ReactNode
}) {
  const error = resultError(result)
  if (error !== null) return <>{failed(error)}</>
  const value = resultValue(result)
  return <>{value === undefined ? waiting : children(value, result.waiting)}</>
}
