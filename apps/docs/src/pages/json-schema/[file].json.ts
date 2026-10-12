/** The JSON Schemas for the two .cms files, served from the spec package so they match the code. */

import type { APIRoute } from "astro";
import { readRepoFile } from "../../lib/repo";

const FILES = ["schema.schema", "config.schema"];

export function getStaticPaths() {
  return FILES.map((file) => ({ params: { file } }));
}

export const GET: APIRoute = ({ params }) =>
  new Response(readRepoFile(`packages/spec/json-schema/${params.file}.json`), {
    headers: { "content-type": "application/schema+json; charset=utf-8" },
  });
