/** Each docs page as Markdown, for agents and for anyone who wants the source. */

import type { APIRoute } from "astro";
import { docsPages } from "../../lib/cms";

export function getStaticPaths() {
  return docsPages().map((page) => ({ params: { slug: page.slug }, props: { page } }));
}

export const GET: APIRoute = ({ props }) => {
  const { page } = props;
  const summary = page.summary ? `> ${page.summary}\n\n` : "";
  return new Response(`# ${page.title}\n\n${summary}${page.body.trim()}\n`, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
};
