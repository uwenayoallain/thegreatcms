/** Open to every crawler, and pointed at the sitemap. */

import type { MetadataRoute } from "next";
import { origin } from "#lib/cms";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/" }, sitemap: new URL("/sitemap.xml", origin).href };
}
