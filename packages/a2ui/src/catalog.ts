// The catalog the board's A2UI surfaces use (HE-77): A2UI's basic catalog, v1.0, as the published `@a2ui/web_core`
// defines it (components, functions, theme). The server reads it for the rules it gives agents and to check a block;
// the web app draws the same components with its own look (a catalog of the same id, so what checks here renders there).
import { Catalog } from "@a2ui/web_core"
import type { ComponentApi } from "@a2ui/web_core"
import { BASIC_COMPONENTS, BASIC_FUNCTIONS, BasicCatalogThemeSchema } from "@a2ui/web_core/catalogs/basic/v1"

/** The basic catalog's id, v1.0. */
export const BASIC_CATALOG_ID = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json"

/** The protocol version the board speaks. */
export const PROTOCOL_VERSION = "1.0"

/** The basic catalog, its components as schemas: what the server checks and teaches. */
export const basicCatalog = (): Catalog<ComponentApi> =>
  new Catalog(BASIC_CATALOG_ID, PROTOCOL_VERSION, BASIC_COMPONENTS, BASIC_FUNCTIONS, BasicCatalogThemeSchema)

/** The basic catalog with a renderer's own components (of the same names, and the same functions and theme). */
export const basicCatalogOf = <T extends ComponentApi>(components: ReadonlyArray<T>): Catalog<T> =>
  new Catalog(BASIC_CATALOG_ID, PROTOCOL_VERSION, components, BASIC_FUNCTIONS, BasicCatalogThemeSchema)

/** A basic component's API (its name and props schema), which a renderer implements. */
export const basicComponent = (name: string): ComponentApi | undefined => BASIC_COMPONENTS.find((c) => c.name === name)
