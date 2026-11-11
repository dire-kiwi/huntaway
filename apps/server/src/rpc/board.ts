import { Effect } from "effect"
import { BoardRpcs } from "@huntaway/contracts"
import { Board } from "../lifecycle/Board.ts"

export const BoardHandlers = BoardRpcs.toLayer(
  Effect.gen(function* () {
    const board = yield* Board
    return BoardRpcs.of({ "board.watch": ({ since }) => board.watch(since) })
  }),
)
