import { Effect } from "effect"
import { BoardRpcs, Invalid } from "@huntaway/contracts"
import { PullRequests } from "../github/PullRequests.ts"
import { Board } from "../board/Board.ts"

export const BoardHandlers = BoardRpcs.toLayer(
  Effect.gen(function* () {
    const board = yield* Board
    const pullRequests = yield* PullRequests
    return BoardRpcs.of({
      "board.watch": ({ since }) => board.watch(since),
      "board.previewStatus": ({ url }) =>
        url.startsWith("http://") || url.startsWith("https://")
          ? pullRequests.previewStatus(url)
          : Effect.fail(new Invalid({ field: "url", reason: "url must be http(s)" })),
    })
  }),
)
