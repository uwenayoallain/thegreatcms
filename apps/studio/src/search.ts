/** Finding content by what it says, across every region and entry of one site. */

import { isBlocksRegion } from "@greatcms/spec";
import { flatten } from "./elsewhere.js";
import type { SiteClient, SiteContext } from "./sites.js";
import { idFor } from "./views/fields.js";

export interface SearchHit {
  /** Where it lives, as the sidebar names it. */
  place: string;
  label: string;
  /** The words around the match, with the match itself in `match`. */
  before: string;
  match: string;
  after: string;
  href: string;
}

const plain = (value: string) =>
  value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** Case- and accent-insensitive, so "cafe" finds "Café". */
const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export async function searchSite(
  client: SiteClient,
  context: SiteContext,
  siteId: string,
  query: string,
  limit = 60,
): Promise<SearchHit[]> {
  const needle = fold(query.trim());
  if (needle.length < 2) return [];

  const documents: Array<{ place: string; href: string; values: ReturnType<typeof values> }> = [];
  const values = (fields: Parameters<typeof flatten>[0], document: Record<string, unknown>) => {
    const out: Parameters<typeof flatten>[4] = [];
    flatten(fields, document, [], context.schema.blocks, out);
    return out;
  };

  const regions = Object.entries(context.schema.regions);
  const resolved = await Promise.all(
    regions.map(async ([regionId]) => {
      const draft = await client.readLiveDraft({ context, regionId });
      return draft ?? (await client.resolvedRegion(context, regionId));
    }),
  );
  regions.forEach(([regionId, region], index) => {
    const document = resolved[index] ?? {};
    documents.push({
      place: region.label ?? regionId,
      href: `/sites/${siteId}/regions/${regionId}`,
      values: isBlocksRegion(region)
        ? values({ blocks: { type: "blocks", allow: region.allow } }, document)
        : values(region.fields, document),
    });
  });

  const collections = Object.entries(context.schema.collections);
  const lists = await Promise.all(collections.map(([name]) => client.listEntries(context, name)));
  collections.forEach(([name, collection], index) => {
    for (const entry of lists[index] ?? []) {
      documents.push({
        place: `${collection.label ?? name}: ${entry.slug}`,
        href: `/sites/${siteId}/collections/${name}/${encodeURIComponent(entry.slug)}`,
        values: values(collection.fields, entry.data),
      });
    }
  });

  const hits: SearchHit[] = [];
  for (const document of documents) {
    for (const value of document.values) {
      if (value.kind === "image") continue;
      const text = plain(value.value);
      const at = fold(text).indexOf(needle);
      if (at === -1) continue;
      const start = Math.max(0, at - 50);
      const end = Math.min(text.length, at + needle.length + 70);
      hits.push({
        place: document.place,
        label: value.label,
        before: `${start > 0 ? "…" : ""}${text.slice(start, at)}`,
        match: text.slice(at, at + needle.length),
        after: `${text.slice(at + needle.length, end)}${end < text.length ? "…" : ""}`,
        href: `${document.href}#${idFor(value.dotted.split("."))}`,
      });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}
