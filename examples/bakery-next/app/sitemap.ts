/** The pages worth finding; the thank-you and not-found pages are left out. */

import type { MetadataRoute } from "next";
import { origin } from "#lib/cms";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["/", "/menu/"].map((path) => ({ url: new URL(path, origin).href }));
}
