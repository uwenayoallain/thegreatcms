/** The studio's live preview for Next.js: one component in the root layout's head. */

import { createElement, type ReactElement } from "react";
import { PREVIEW_SCRIPT } from "./vite.js";

/** `next dev` does not watch content files, so the page asks the studio to reload it after each draft. */
const UNWATCHED = "window.__greatcmsUnwatched = true;";

/**
 * Renders the preview script in development and nothing at all otherwise, so a
 * built page carries none of it.
 *
 *     import { GreatcmsPreview } from "@greatcms/reader/next";
 *     <head><GreatcmsPreview /></head>
 */
export function GreatcmsPreview(): ReactElement | null {
  if (process.env.NODE_ENV !== "development") return null;
  return createElement("script", {
    type: "module",
    "data-greatcms-preview": "",
    dangerouslySetInnerHTML: { __html: UNWATCHED + PREVIEW_SCRIPT },
  });
}

export default GreatcmsPreview;
