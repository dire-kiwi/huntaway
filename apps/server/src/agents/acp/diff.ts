// A unified diff of a file's text before and after an edit, as Codex reports a file change (`fileChange`'s `diff`): ACP's
// `diff` tool content gives the whole old and new text, and the thread shows the diff (tools.tsx' PatchDiff). Its hunks
// have three lines of context. Plain code: a line-by-line longest common subsequence, which for files too large for that
// is one hunk replacing the whole text.

const CONTEXT = 3
/** The most cells the subsequence's table may have (old lines × new lines). */
const MAX_CELLS = 4_000_000

const linesOf = (text: string): ReadonlyArray<string> => {
  if (text === "") return []
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

type Op = { readonly t: " " | "-" | "+"; readonly line: string }

const ops = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): ReadonlyArray<Op> => {
  // The common start and end, which most edits leave alone.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  const x = a.slice(start, a.length - end)
  const y = b.slice(start, b.length - end)
  const head = a.slice(0, start).map((line): Op => ({ t: " ", line }))
  const tail = a.slice(a.length - end).map((line): Op => ({ t: " ", line }))
  if (x.length * y.length > MAX_CELLS) {
    return [...head, ...x.map((line): Op => ({ t: "-", line })), ...y.map((line): Op => ({ t: "+", line })), ...tail]
  }
  const n = x.length
  const m = y.length
  const w = m + 1
  const table = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] = x[i] === y[j] ? (table[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * w + j] ?? 0, table[i * w + j + 1] ?? 0)
    }
  }
  const mid: Array<Op> = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      mid.push({ t: " ", line: x[i] ?? "" })
      i++
      j++
    } else if (i < n && (j >= m || (table[(i + 1) * w + j] ?? 0) >= (table[i * w + j + 1] ?? 0))) {
      mid.push({ t: "-", line: x[i] ?? "" })
      i++
    } else {
      mid.push({ t: "+", line: y[j] ?? "" })
      j++
    }
  }
  return [...head, ...mid, ...tail]
}

/** The unified diff (hunks only, no file header) from `before` to `after`; a new file's (`before` null) is all `+` lines. */
export const unifiedDiff = (before: string | null, after: string): string => {
  const a = linesOf(before ?? "")
  const b = linesOf(after)
  const all = ops(a, b)
  const changed = all.flatMap((op, k) => (op.t === " " ? [] : [k]))
  if (changed.length === 0) return ""
  // Hunks: runs of changes with their context, those closer than twice the context merged.
  const hunks: Array<[number, number]> = []
  for (const k of changed) {
    const from = Math.max(0, k - CONTEXT)
    const to = Math.min(all.length, k + CONTEXT + 1)
    const last = hunks.at(-1)
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to)
    else hunks.push([from, to])
  }
  const out: Array<string> = []
  // Line numbers before each op, in the old and new text.
  let oldAt = 1
  let newAt = 1
  let k = 0
  for (const [from, to] of hunks) {
    for (; k < from; k++) {
      const t = all[k]?.t
      if (t !== "+") oldAt++
      if (t !== "-") newAt++
    }
    const body = all.slice(from, to)
    const oldCount = body.filter((o) => o.t !== "+").length
    const newCount = body.filter((o) => o.t !== "-").length
    out.push(`@@ -${oldCount === 0 ? oldAt - 1 : oldAt},${oldCount} +${newCount === 0 ? newAt - 1 : newAt},${newCount} @@`)
    for (const o of body) out.push(`${o.t}${o.line}`)
    for (; k < to; k++) {
      const t = all[k]?.t
      if (t !== "+") oldAt++
      if (t !== "-") newAt++
    }
  }
  return `${out.join("\n")}\n`
}
