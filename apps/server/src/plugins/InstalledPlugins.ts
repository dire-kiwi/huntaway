import { Context, Layer } from "effect"
import type { Plugin } from "@huntaway/plugin"

// HE-34: the plugins this server runs (docs/plan/15-plugins.md, Installing). The composition root gives the ones the
// server was built with (`installed.ts`), with the example `notes` plugin on a demo board; a test gives its own.

export interface InstalledPluginsShape {
  readonly plugins: ReadonlyArray<Plugin>
}

export class InstalledPlugins extends Context.Service<InstalledPlugins, InstalledPluginsShape>()("huntaway-server/plugins/InstalledPlugins") {
  static readonly layer = (plugins: ReadonlyArray<Plugin>) => Layer.succeed(InstalledPlugins, InstalledPlugins.of({ plugins }))
}
