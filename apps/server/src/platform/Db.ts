import { SqliteClient } from "@effect/sql-sqlite-node"
import { Context, Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { DataDir } from "./DataDir.ts"

export interface DbShape {
  /**
   * One transaction. Events emitted inside are published after it commits, none if it rolls back. A nested `tx` joins
   * the outer one (a savepoint). It must contain database statements and pure code only: no process, network, file
   * system or sleep. `SqlError` from our own database is a defect.
   */
  readonly tx: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly sql: SqlClient.SqlClient
}

/** The board's SQLite database (docs/plan/04-database.md): one file, one connection, WAL. */
export class Db extends Context.Service<Db, DbShape>()("huntaway-server/platform/Db") {
  /** `Db` over the `SqlClient` in the environment, with the pragmas every connection gets. */
  static readonly layerOver = Layer.effect(
    Db,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`PRAGMA foreign_keys = ON`.pipe(Effect.orDie)
      yield* sql`PRAGMA synchronous = NORMAL`.pipe(Effect.orDie)
      yield* sql`PRAGMA journal_size_limit = 33554432`.pipe(Effect.orDie)
      const tx = <A, E, R>(effect: Effect.Effect<A, E, R>) => sql.withTransaction(effect).pipe(Effect.catchTag("SqlError", (e) => Effect.die(e)))
      return Db.of({ tx, sql })
    }),
  )

  /** The data folder's `board.db`. */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const dataDir = yield* DataDir
      // A database that cannot be opened is a defect: the data folder was checked when `DataDir` made it.
      const client = Layer.orDie(SqliteClient.layer({ filename: dataDir.database, busyTimeout: "5 seconds" }))
      // The database files are private, as the data folder is (0600).
      const privateFiles = Layer.effectDiscard(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          for (const file of [dataDir.database, `${dataDir.database}-wal`, `${dataDir.database}-shm`]) {
            yield* fs.chmod(file, 0o600).pipe(Effect.ignore)
          }
        }),
      )
      return Layer.provideMerge(Layer.merge(Db.layerOver, privateFiles), client)
    }),
  )

  /** A fresh database in memory, for tests. */
  static readonly layerMemory = Layer.provideMerge(Db.layerOver, Layer.orDie(SqliteClient.layer({ filename: ":memory:" })))
}
