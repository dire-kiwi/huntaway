import type { Effect } from "effect"
import type { PluginSession } from "./context.ts"
import type { PluginError } from "./errors.ts"

// A plugin's pages (docs/plan/15-plugins.md, Pages): HTML the plugin renders on the server, which the board shows in a
// sandboxed frame under its strict content security policy (no network: images are `data:` or `blob:` URLs, data comes
// through `huntaway.call`), with the board's theme as CSS variables and a small bridge to the board (`huntaway.*`).
//
// The slots: `page` is the plugin's own page at `/<plugin id>/<path>` (with an entry in the board's menu when `nav` is
// set); `settings` a section of Settings; `task` a small panel on every task's page (`task_id` set). Links in a page
// that point at the board (`/<plugin id>/...`, `/t/<task id>`, a relative link) open in the board; others in a new tab
// once the user clicks them.

export type PageSlot = "page" | "settings" | "task"

export interface PageRequest {
  readonly slot: PageSlot
  /** The path under `/<plugin id>/`, without a leading `/` (`""` for the plugin's first page). */
  readonly path: string
  /** The page address's query. */
  readonly query: Readonly<Record<string, string>>
  /** The task whose page shows it (the `task` slot). */
  readonly task_id: string | null
  readonly session: PluginSession
}

/** A page: HTML to show, or another of the plugin's paths to go to. */
export type PageResult =
  | {
      readonly _tag: "Html"
      /** For the browser's tab (the `page` slot). */
      readonly title: string | null
      /** What goes in the frame's body: markup, `<style>` and `<script>` (inline: the policy allows no other). */
      readonly html: string
      /** Nothing to show: the `task` slot leaves a task's page as it is. */
      readonly empty: boolean
    }
  | { readonly _tag: "Redirect"; readonly path: string }

export const Page = {
  html: (html: string, options?: { readonly title?: string | undefined }): PageResult => ({ _tag: "Html", title: options?.title ?? null, html, empty: false }),
  /** For the `task` slot: nothing about this task. */
  empty: { _tag: "Html", title: null, html: "", empty: true } satisfies PageResult as PageResult,
  redirect: (path: string): PageResult => ({ _tag: "Redirect", path }),
}

export interface PluginPages {
  /** The board's menu has an entry for the plugin's page. */
  readonly nav?: { readonly title: string } | undefined
  /** Settings has a section for it (rendered with slot `settings`). */
  readonly settings?: { readonly title: string } | undefined
  /** Every task's page has a panel for it (rendered with slot `task`). */
  readonly task?: boolean | undefined
  readonly render: (request: PageRequest) => Effect.Effect<PageResult, PluginError>
}
