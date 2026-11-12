import { Effect, Ref, Schema } from "effect"

// `import-report.json` (docs/plan/11-migration.md, The importer): what was read and written per table, every row that
// could not be imported and why, every stored JSON value the new schema does not read, notes, and how each old
// `messages` row was accounted for. `--check` fails if it has a failure in it.

/** One row or value the report names: its table, its key and what was wrong. */
export const Problem = Schema.Struct({ table: Schema.String, key: Schema.String, error: Schema.String })
export type Problem = typeof Problem.Type

export const TableCount = Schema.Struct({
  /** Rows the old database has in the table(s) this new table comes from, as the family counted them. */
  old: Schema.Int,
  /** Rows written. */
  written: Schema.Int,
  /** Rows converted and checked but not written: a rehearsal's credentials. */
  withheld: Schema.Int,
})

export const ReportJson = Schema.Struct({
  from: Schema.String,
  database: Schema.String,
  at: Schema.String,
  rehearsal: Schema.Boolean,
  tables: Schema.Record(Schema.String, TableCount),
  /** Rows not written: the old row or the new one did not decode, or the row points at nothing. */
  failures: Schema.Array(Problem),
  /** Stored JSON values the new schema does not read (the row is written; the server reads the value as its default). */
  json: Schema.Array(Problem),
  /** Things to know that are not failures: a path not on disk, a task that targets a subproject's branch… */
  notes: Schema.Array(Problem),
  /** Old `messages` rows of tasks on items, per task key: converted to items, or carried as one notice item. */
  messages: Schema.Struct({ converted: Schema.Record(Schema.String, Schema.Int), carried: Schema.Record(Schema.String, Schema.Int) }),
  /** What `--check` found, when it ran. */
  check: Schema.NullOr(Schema.Struct({ ok: Schema.Boolean, problems: Schema.Array(Problem) })),
})
export type ReportJson = typeof ReportJson.Type

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** The report being gathered: the families and the check add to it. */
export interface Report {
  readonly failure: (table: string, key: string, error: string) => Effect.Effect<void>
  readonly json: (table: string, key: string, error: string) => Effect.Effect<void>
  readonly note: (table: string, key: string, error: string) => Effect.Effect<void>
  /** Counts `n` old rows behind `table` (added to what is there). */
  readonly old: (table: string, n: number) => Effect.Effect<void>
  readonly written: (table: string, n: number) => Effect.Effect<void>
  readonly withheld: (table: string, n: number) => Effect.Effect<void>
  /** An old `messages` row of task `key` turned into items (`converted`) or into one notice (`carried`). */
  readonly message: (key: string, how: "converted" | "carried") => Effect.Effect<void>
  readonly checked: (problems: ReadonlyArray<Problem>) => Effect.Effect<void>
  readonly get: Effect.Effect<ReportJson>
}

const emptyCount = { old: 0, written: 0, withheld: 0 }

export const makeReport = (header: { readonly from: string; readonly database: string; readonly at: string; readonly rehearsal: boolean }) =>
  Effect.gen(function* () {
    const state = yield* Ref.make<Mutable<ReportJson>>({
      ...header,
      tables: {},
      failures: [],
      json: [],
      notes: [],
      messages: { converted: {}, carried: {} },
      check: null,
    })
    const count = (field: keyof typeof emptyCount) => (table: string, n: number) =>
      Ref.update(state, (s) => ({
        ...s,
        tables: { ...s.tables, [table]: { ...(s.tables[table] ?? emptyCount), [field]: (s.tables[table]?.[field] ?? 0) + n } },
      }))
    const add = (list: "failures" | "json" | "notes") => (table: string, key: string, error: string) =>
      Ref.update(state, (s) => ({ ...s, [list]: [...s[list], { table, key, error }] }))
    const report: Report = {
      failure: add("failures"),
      json: add("json"),
      note: add("notes"),
      old: count("old"),
      written: count("written"),
      withheld: count("withheld"),
      message: (key, how) =>
        Ref.update(state, (s) => ({ ...s, messages: { ...s.messages, [how]: { ...s.messages[how], [key]: (s.messages[how][key] ?? 0) + 1 } } })),
      checked: (problems) => Ref.update(state, (s) => ({ ...s, check: { ok: problems.length === 0, problems } })),
      get: Ref.get(state),
    }
    return report
  })

/** Whether `--check` passes on a report: no failure, no JSON value the schema does not read, and the check found nothing. */
export const reportPasses = (r: ReportJson) => r.failures.length === 0 && r.json.length === 0 && (r.check?.ok ?? true)
