// `/docs/<profile>` (HA-281): the profile's documents, which its agents publish through the `docs` MCP server (HA-280),
// and each document's pages, with its menu and versions (6.3, step 1). See docs.ts for where they're kept. Its parts are in
// `docsPage/`: the list and its tree, a document's view, and their dialogs.
import { DocsList } from "./docsPage/DocsList"
import { DocView } from "./docsPage/DocView"
import { useHomes } from "./docsPage/hooks"
import { docRoute } from "./docs"
import type { DocsRoute } from "./docsPage/model"

export function DocsPage({ route }: { route: DocsRoute }) {
  const { name, homes } = useHomes(route.profile)
  const doc = docRoute(route)
  if (doc === null) return <DocsList segment={route.profile} name={name} homes={homes} />
  return <DocView key={doc.slug} route={doc} name={name} homes={homes} />
}
