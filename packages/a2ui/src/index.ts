// @huntaway/a2ui's light entry: splitting a reply into Markdown and `<a2ui>` blocks, and the message a click sends. It
// imports nothing, so the web app's first chunk and the phone can use it; what parses and draws Express (`@a2ui/agent`)
// is `@huntaway/a2ui/express`, which the web app loads lazily.
export * from "./message.ts"
