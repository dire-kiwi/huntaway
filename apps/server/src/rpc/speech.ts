import { Effect } from "effect"
import { SpeechRpcs } from "@huntaway/contracts"
import { Speech } from "../speech/Speech.ts"

export const SpeechHandlers = SpeechRpcs.toLayer(
  Effect.gen(function* () {
    const speech = yield* Speech
    return SpeechRpcs.of({
      "speech.status": () => speech.status,
      "speech.download": ({ model }) => speech.download(model),
      "speech.cancel": () => speech.cancel,
      "speech.remove": ({ model }) => speech.remove(model),
      "speech.select": ({ model }) => speech.select(model),
      "speech.transcribe": ({ audio }) => speech.transcribe(audio),
    })
  }),
)
