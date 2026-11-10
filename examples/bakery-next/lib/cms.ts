/** Every page reads content here, through the reader, at build time: nothing is fetched at runtime. */

import { createReader } from "@greatcms/reader";

export interface Identity {
  name: string;
  tagline?: string;
  address?: string;
  phone?: string;
  email?: string;
  notice?: string;
}

export interface MenuItem {
  slug: string;
  name: string;
  category: "bread" | "pastry" | "coffee";
  price: number;
  description?: string;
  dietary?: string[];
  featured?: boolean;
}

const CATEGORIES = [
  { value: "bread", label: "Bread" },
  { value: "pastry", label: "Pastry" },
  { value: "coffee", label: "Coffee & tea" },
] as const;

const DIETARY: Record<string, string> = {
  vegan: "Vegan",
  "gluten-free": "Gluten-free",
  nuts: "Contains nuts",
};

/** `next dev` renders on every request, so a fresh reader there shows the studio's drafts. */
export const previewing = process.env.NODE_ENV === "development";

function reader() {
  // The site's own folder: `next` runs from it in dev and in a build.
  return createReader({ root: process.cwd(), drafts: previewing });
}

export function content() {
  const cms = reader();
  const menu = cms
    .collection("menu")
    .map((entry) => Object.assign({ slug: entry.slug }, entry.data as Omit<MenuItem, "slug">))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  return {
    identity: cms.region("site.identity") as Identity,
    hero: cms.region("home.hero") as {
      eyebrow?: string;
      heading: string;
      lede?: string;
      cta?: { href: string; label?: string };
    },
    story: cms.region("home.story") as { heading: string; body?: { html: string } },
    visit: cms.region("visit.hours") as {
      hours?: Array<{ days: string; open: string }>;
      note?: string;
    },
    featured: menu.filter((item) => item.featured),
    sections: CATEGORIES.map((category) => ({
      ...category,
      items: menu.filter((item) => item.category === category.value),
    })).filter((section) => section.items.length > 0),
  };
}

export const price = (value: number) => `RWF ${Number(value).toLocaleString("en-US")}`;
export const dietary = (values: string[] = []) => values.map((value) => DIETARY[value] ?? value);
export const categoryLabel = (value: string) =>
  CATEGORIES.find((category) => category.value === value)?.label ?? value;

/** The address the site is published at: canonical links, the sitemap and share cards are built on it. */
export const origin = process.env.SITE_URL ?? "https://hearth.example";

/** A page's own address, for its canonical link and its share card; a page's `openGraph` replaces the layout's whole. */
export const address = (path: string) => ({
  alternates: { canonical: path },
  openGraph: { type: "website" as const, url: path, images: ["/og.png"] },
});

/** Where the order form posts: the studio's inbox, not a form service. */
export const studio = {
  url: process.env.PUBLIC_CMS_URL ?? "",
  site: process.env.PUBLIC_CMS_SITE_ID ?? "bakery",
};
