import type { Plugin } from "@huntaway/plugin"

// HE-34: the plugins this server is built with (docs/plan/15-plugins.md, Installing). A plugin is a package: added to
// apps/server/package.json (a GitHub release's tarball URL, as `@dire-kiwi/docs-render` is), imported here and listed
// below, in the order the board shows them. Each runs on every host this build runs on.

export const installed: ReadonlyArray<Plugin> = []
