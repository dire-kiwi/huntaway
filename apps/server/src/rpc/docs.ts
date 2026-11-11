import { Effect } from "effect"
import { DocRpcs } from "@huntaway/contracts"
import { Docs } from "../docs/Docs.ts"
import { HostedDocs, siteUrl } from "../docs/HostedDocs.ts"
import { ProfileRepo } from "../profiles/ProfileRepo.ts"
import { NotFound } from "@huntaway/contracts"
import type { ProfileId } from "@huntaway/contracts"
import { Option } from "effect"

// 6.3: a profile's published documents and its docs site (docs/plan/inventory/02-agent-support.md 2.8).

export const DocHandlers = DocRpcs.toLayer(
  Effect.gen(function* () {
    const docs = yield* Docs
    const hosted = yield* HostedDocs
    const profiles = yield* ProfileRepo
    /** The profile, there. */
    const profile = (id: ProfileId) =>
      Effect.flatMap(profiles.get(id), (p) => (Option.isNone(p) ? Effect.fail(new NotFound({ what: "profile", id })) : Effect.succeed(id)))
    return DocRpcs.of({
      "docs.list": ({ profile_id, label }) => docs.list(profile_id, label ?? null),
      "docs.get": ({ profile_id, slug }) => docs.get(profile_id, slug),
      "docs.update": ({ profile_id, slug, patch }) => docs.update(profile_id, slug, patch),
      "docs.delete": ({ profile_id, slug }) => docs.delete(profile_id, slug),
      "docs.renameFolder": ({ profile_id, from, to }) => docs.renameFolder(profile_id, from, to),
      "docs.labels": ({ profile_id }) => docs.labels(profile_id),
      "docs.image": ({ profile_id, sha256 }) => docs.image(profile_id, sha256),
      "docs.version": ({ profile_id, slug, version, base_url, path, first }) => docs.version(profile_id, slug, version, { base_url, path, first }),
      "docs.publish": ({ profile_id, slug, version, remote_slug, ask }) =>
        Effect.flatMap(profile(profile_id), (p) => hosted.publish(p, slug, version ?? null, { slug: remote_slug, ask })),
      "docs.comments": ({ profile_id, slug }) => docs.comments(profile_id, slug),
      "docs.addComment": ({ profile_id, slug, comment }) => docs.addComment(profile_id, slug, comment),
      "docs.updateComment": ({ profile_id, slug, id, comment }) => docs.updateComment(profile_id, slug, id, comment),
      "docs.deleteComment": ({ profile_id, slug, id }) => docs.deleteComment(profile_id, slug, id),
      "docs.sendComments": ({ profile_id, slug }) => docs.sendComments(profile_id, slug),
      "docs.hostedStatus": ({ profile_id }) => Effect.flatMap(profile(profile_id), hosted.status),
      "docs.hostedDisconnect": ({ profile_id }) => Effect.flatMap(profile(profile_id), hosted.disconnect),
      "docs.hostedDeviceStart": ({ profile_id, site_url }) =>
        Effect.flatMap(profile(profile_id), (p) => Effect.flatMap(siteUrl(site_url), (site) => hosted.startDevice(p, site))),
      "docs.hostedDeviceCancel": ({ profile_id }) => Effect.flatMap(profile(profile_id), hosted.cancelDevice),
      "docs.hostedToken": ({ profile_id, site_url, token }) =>
        Effect.flatMap(profile(profile_id), (p) => Effect.flatMap(siteUrl(site_url), (site) => hosted.connectToken(p, site, token))),
    })
  }),
)
