// The thread protocol (docs/threads.md): the model the server keeps tasks' threads as, with the reducer that both ends
// fold events with. It's the server's own file, which has no imports, so the web board and the phone take it from here.
export * from "../../../apps/server/src/threads/protocol.ts";
