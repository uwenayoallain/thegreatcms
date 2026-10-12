/** The overview as Markdown: the repository README, which docs.json names as its source. */

import type { APIRoute } from "astro";
import { readRepoFile } from "../lib/repo";

export const GET: APIRoute = () =>
  new Response(readRepoFile("README.md"), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
