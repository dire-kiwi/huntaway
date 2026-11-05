// The model the server keeps tasks' threads as: items, requests, numbered events, snapshots and windows, with the reducer
// both ends fold events with. It's one file the server and the app share, imported by relative path (Vite bundles it,
// and the app's typecheck checks it with the app's settings). See docs/threads.md. Nothing in the app uses it yet: the
// thread view moves onto it in step 5 of the agent-threads plan (HA-218).
export * from "../../server-ts/src/threads/protocol.ts";
