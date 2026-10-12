/** The standard as Markdown, at the URL llms.txt promises. */

import type { APIRoute } from "astro";
import { readRepoFile } from "../lib/repo";

export const GET: APIRoute = () =>
  new Response(readRepoFile("SPEC.md"), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
