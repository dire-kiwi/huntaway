import docs from "@dire-kiwi/docs-huntaway"
import type { Plugin } from "@huntaway/plugin"

// HE-34: the plugins this server is built with (docs/plan/15-plugins.md, Installing). A plugin is a package: added to
// apps/server/package.json (a GitHub release's tarball URL: there is no registry), imported here and listed below, in
// the order the board shows them. Each runs on every host this build runs on.
//
// HE-42: `docs`, the docs project's (dire-kiwi/docs, `huntaway/`): the board's published documents, which it had built
// in before. On its first run on a host it copies the board's `doc*` tables (`IMPORTABLE`, start.ts).

export const installed: ReadonlyArray<Plugin> = [docs]
