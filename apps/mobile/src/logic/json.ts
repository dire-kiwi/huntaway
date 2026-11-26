import { Option, Schema } from "effect"

// JSON through Effect's Schema (as the web app's components/ui/json.ts): what a web view's page posts, what goes into
// its page as a script's argument, a tool's result.

const Json = Schema.fromJsonString(Schema.Unknown)
const decode = Schema.decodeUnknownOption(Json)
const encode = Schema.encodeUnknownOption(Json)

/** The value `text` holds, or undefined when it isn't JSON (or is null). */
export const parseJson = (text: string | null | undefined): unknown => (text == null ? undefined : Option.getOrUndefined(decode(text)))

/** `value` as JSON text ("null" when it can't be). */
export const toJson = (value: unknown): string => Option.getOrElse(encode(value), () => "null")
