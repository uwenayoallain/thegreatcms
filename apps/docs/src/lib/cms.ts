import { createReader } from "@greatcms/reader";

/** One reader for the site. Every read happens during the build. */
export const cms = createReader({ root: new URL("../../", import.meta.url).pathname });

export interface Hero {
  eyebrow?: string;
  heading: string;
  subtitle?: string;
  cta?: { href: string; label?: string };
}

export interface Closing {
  heading: string;
  body: string;
}

export interface DocEntry {
  slug: string;
  title: string;
  summary?: string;
  order: number;
  body: string;
}

/** Docs pages, ordered as the schema says and then alphabetically. */
export function docsPages(): DocEntry[] {
  return cms
    .collection("docs")
    .map((entry) => ({
      slug: entry.slug,
      title: String(entry.data.title),
      summary: entry.data.summary as string | undefined,
      order: Number(entry.data.order ?? 50),
      body: entry.body,
    }))
    .toSorted((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}
