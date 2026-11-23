import { Effect, Option, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import { Atom } from "effect/reactivity"
import { Health } from "@huntaway/contracts"
import * as Network from "expo-network"
import { Platform } from "react-native"
import { addFound, candidates, type FoundBoard, foundBoard } from "../logic/discovery"

// The boards on the phone's network (HE-91; src/logic/discovery.ts): its /24 asked on one port, many at once, each
// given a moment to answer. On the web build (a check on a computer) the phone is the computer, so only this machine
// is asked: expo-network's web address lookup asks a service on the internet.

/** How long an address has to answer: a board on the LAN answers in milliseconds, an empty address never. */
const ANSWER_WITHIN = "1500 millis"
/** How many addresses are asked at once. */
const AT_ONCE = 32

const runtime = Atom.runtime(FetchHttpClient.layer)

/** The phone's own address on its network, if it has one. */
const ownAddress: Effect.Effect<string | null> =
  Platform.OS === "web"
    ? Effect.succeed(null)
    : Effect.tryPromise({ try: () => Network.getIpAddressAsync(), catch: () => "no address" }).pipe(Effect.orElseSucceed(() => null))

/** Where else a board may be: this computer for the web build; the computer an Android emulator runs on. */
const extra: ReadonlyArray<string> = Platform.OS === "web" ? ["127.0.0.1"] : Platform.OS === "android" ? ["10.0.2.2"] : []

/** What `url` says it is, if it answers `/api/health` as a board does. */
const ask = (url: string) =>
  HttpClient.get(`${url}/api/health`).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Health)),
    Effect.map((health) => foundBoard(url, health)),
    Effect.timeoutOption(ANSWER_WITHIN),
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed((): FoundBoard | null => null),
  )

/**
 * The boards answering on `port`, growing as they answer; waiting until every address has answered or given up.
 * Refresh it to look again.
 */
export const boardsOnNetworkAtom = Atom.family((port: number) =>
  runtime.atom(
    Stream.fromEffect(ownAddress).pipe(
      Stream.flatMap((ip) => Stream.fromIterable(candidates(ip, extra, port)), { concurrency: 1 }),
      Stream.mapEffect(ask, { concurrency: AT_ONCE }),
      Stream.filter((found): found is FoundBoard => found !== null),
      Stream.scan(
        (): ReadonlyArray<FoundBoard> => [],
        (all, board) => addFound(all, board),
      ),
    ),
  ),
)
