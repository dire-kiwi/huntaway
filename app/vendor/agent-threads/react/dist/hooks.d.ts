import type { Attachment, Command, PermissionMode, Resolution } from "@dire-kiwi/agent-threads-protocol";
import { type ReactNode } from "react";
import { ThreadStore, type LoadEarlierOptions, type ThreadSource, type ThreadState } from "./store.js";
import type { ThreadConfig } from "./config.js";
/**
 * The store for `source`, connected to it while the component is mounted. A new source (e.g. after
 * a reconnect, with a fresh snapshot) makes a new store.
 */
export declare function useThreadStore(source: ThreadSource): ThreadStore;
/**
 * A thread's state, from `source`: its snapshot with the events since applied by applyEvent. Gaps
 * in seq ask the source for a resync. The component redraws for every event; inside a
 * ThreadProvider, useThreadState picks out just what a component needs.
 */
export declare function useThread(source: ThreadSource): ThreadState;
/** What a component sends commands with: the app carries them to the backend, and may return a promise to say how it went. */
export type CommandHandler = (command: Command) => void | Promise<unknown>;
export interface ThreadProviderProps extends ThreadConfig {
    /** Where the thread's events come from. */
    source: ThreadSource;
    /** Called with each command (send, interrupt, respond, set_options) for the app to send to the backend. */
    onCommand: CommandHandler;
    children?: ReactNode;
}
/**
 * Gives the components inside it a thread: its state from `source`, `onCommand` for the commands
 * they send, and the app's renderers (see ThreadConfig). Pass renderers that stay the same (made
 * once, or memoized): new ones redraw every row.
 */
export declare function ThreadProvider({ source, onCommand, children, tools, toolKinds, renderMarkdown, renderItem }: ThreadProviderProps): import("react").JSX.Element;
/** Whether there's a ThreadProvider around. */
export declare const useHasThread: () => boolean;
/**
 * Part of the thread's state, inside a ThreadProvider: the component redraws only when it changes.
 * `pick` mustn't make a new object each time (picking a part of the state, or a Map's get, is fine).
 */
export declare function useThreadState<T>(pick: (state: ThreadState) => T): T;
export declare function useThreadState(): ThreadState;
/** The app's renderers (see ThreadConfig). */
export declare const useThreadConfig: () => ThreadConfig;
/** Sends a raw command for the thread (its thread_id filled in). */
export declare function useCommand(): (command: DistributiveOmit<Command, "thread_id">) => void | Promise<unknown>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export interface SendOptions {
    attachments?: Attachment[];
    /** Copied to the user_message the backend makes of it. Made up if left out. */
    client_id?: string;
}
/** Sends the agent a message: it starts a turn, or steers the running one. */
export declare function useSend(): (text: string, options?: SendOptions) => void | Promise<unknown>;
/** Stops the running turn. */
export declare function useInterrupt(): () => void | Promise<unknown>;
/** Answers an open request (a permission or a question). */
export declare function useRespond(): (requestId: string, resolution: Resolution) => void | Promise<unknown>;
export interface ThreadOptions {
    model?: string;
    effort?: string;
    permission_mode?: PermissionMode;
}
/** Changes the thread's model, effort or permission mode; the ones left out stay as they are. */
export declare function useSetOptions(): (options: ThreadOptions) => void | Promise<unknown>;
/**
 * Shows a subagent's row in the thread (see Focus). One that started before the items loaded (its
 * call is only there for context) has the earlier items loaded back to its start.
 */
export declare function useReveal(): (id: string) => void;
/** Whether the thread's snapshot is a window with earlier items to load (with the source's loadEarlier). */
export declare function useHasEarlier(): boolean;
/**
 * Loads the earlier items of a thread whose snapshot is a window (see ThreadStore.loadEarlier): a
 * page, or with `to`, back to that item.
 */
export declare function useLoadEarlier(): (options?: LoadEarlierOptions) => Promise<void>;
/**
 * For a row that holds subagent `id`, or can hold the one being revealed: `open` if the subagent
 * being revealed is in it (or is it), `self` if it's the one, and `done` to say it's shown.
 */
export declare function useRevealed(ids: readonly string[]): {
    open: boolean;
    self: boolean;
    done: () => void;
} | null;
export {};
