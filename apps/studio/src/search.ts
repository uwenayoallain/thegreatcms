/** Finding content by what it says, across every region and entry of one site. */

import { isBlocksRegion } from "@greatcms/spec";
import { flatten } from "./elsewhere.js";
import { type SiteClient, type SiteContext, entryTitle } from "./sites.js";
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

/** Folds `text` keeping, for each folded character, where it came from: folding can change length. */
function foldWithOffsets(text: string): { folded: string; from: number[] } {
  let folded = "";
  const from: number[] = [];
  let at = 0;
  for (const char of text) {
    const piece = fold(char);
    folded += piece;
    for (let i = 0; i < piece.length; i++) from.push(at);
    at += char.length;
  }
  from.push(at);
  return { folded, from };
}

/** Where `needle` is found in `haystack`, as a range of `haystack` itself. */
export function findFolded(haystack: string, needle: string): [number, number] | undefined {
  const { folded, from } = foldWithOffsets(haystack);
  const target = fold(needle);
  const at = folded.indexOf(target);
  if (at === -1) return undefined;
  // The end is where the next source character starts, so a trailing combining accent stays in.
  return [from[at]!, from[at + target.length]!];
}

/** Some words either side of the match, cut back to whole words. */
export function snippet(text: string, start: number, end: number, before = 50, after = 70) {
  let from = Math.max(0, start - before);
  let to = Math.min(text.length, end + after);
  if (from > 0) {
    const space = text.indexOf(" ", from);
    if (space !== -1 && space < start) from = space + 1;
  }
  if (to < text.length) {
    const space = text.lastIndexOf(" ", to);
    if (space > end) to = space;
  }
  return {
    before: `${from > 0 ? "…" : ""}${text.slice(from, start)}`,
    match: text.slice(start, end),
    after: `${text.slice(end, to).trimEnd()}${to < text.length ? "…" : ""}`,
  };
}

export async function searchSite(
  client: SiteClient,
  context: SiteContext,
  siteId: string,
  query: string,
  limit = 60,
): Promise<SearchHit[]> {
  const needle = query.trim();
  if (fold(needle).length < 2) return [];

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
        place: `${collection.label ?? name}: ${entryTitle(collection, entry.data, entry.slug)}`,
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
      const found = findFolded(text, needle);
      if (!found) continue;
      hits.push({
        place: document.place,
        label: value.label,
        ...snippet(text, found[0], found[1]),
        href: `${document.href}#${idFor(value.dotted.split("."))}`,
      });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}
