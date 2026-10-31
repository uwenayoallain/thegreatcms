import { cms } from "#lib/cms.js";

export const prerender = true;

export function load() {
  const reader = cms();
  return {
    identity: reader.region("site.identity"),
    newsletter: reader.region("newsletter"),
    // Where the newsletter form posts: the studio's inbox, read at build time like everything else.
    studio: {
      url: process.env.PUBLIC_CMS_URL ?? "",
      site: process.env.PUBLIC_CMS_SITE_ID ?? "journal",
    },
  };
}
