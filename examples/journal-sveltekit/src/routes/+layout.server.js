import { cms } from "#lib/cms.js";

export const prerender = true;

export function load() {
  const reader = cms();
  const identity = reader.region("site.identity");
  return {
    // Every page describes itself with the tagline unless it has words of its own.
    identity: { ...identity, tagline: identity.tagline ?? `Essays by ${identity.author}.` },
    newsletter: reader.region("newsletter"),
    // Where the newsletter form posts: the studio's inbox, read at build time like everything else.
    studio: {
      url: process.env.PUBLIC_CMS_URL ?? "",
      site: process.env.PUBLIC_CMS_SITE_ID ?? "journal",
    },
  };
}
