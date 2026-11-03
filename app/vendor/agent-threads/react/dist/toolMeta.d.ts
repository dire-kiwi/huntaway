import type { ToolCall } from "@dire-kiwi/agent-threads-protocol";
import type { ToolMeta } from "./config.js";
/** `path` relative to `cwd`, when it's inside it. */
export declare function relative(path: string | undefined, cwd?: string): string;
/** The built-in summary of a call. */
export declare function toolMeta(call: ToolCall, cwd?: string): ToolMeta;
/**
 * A plan's title: its first line, if that's a heading, as plain text ("# Plan: add a `cache`" is
 * "add a cache"); none if it's just "Plan".
 */
export declare function planTitle(plan: string): string;
/** A short line for an input: its first few simple fields. */
export declare function brief(input: unknown): string;
