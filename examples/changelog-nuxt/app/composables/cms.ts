/** The site's content, fetched once per page from the server route that reads it. */

export interface Link {
  href: string;
  label?: string;
}

export interface Release {
  slug: string;
  version: string;
  title: string;
  date: string;
  kind?: "feature" | "improvement" | "fix";
  html: string;
}

export interface Cms {
  identity: { name: string; tagline?: string; signup?: Link };
  hero: { eyebrow?: string; heading: string; lede?: string; cta?: Link };
  features: { heading?: string; items?: Array<{ title: string; body?: string }> };
  pricing: {
    heading?: string;
    plans?: Array<{
      name: string;
      price: string;
      period?: string;
      features?: string[];
      featured?: boolean;
    }>;
  };
  faq: { items?: Array<{ question: string; answer: string }> };
  releases: Release[];
}

export async function useCms(): Promise<Cms> {
  const { data } = await useFetch<Cms>("/api/cms", { key: "cms" });
  if (!data.value) throw createError({ statusCode: 500, statusMessage: "Content did not load." });
  return data.value;
}

export const KINDS: Record<string, string> = {
  feature: "New",
  improvement: "Improved",
  fix: "Fixed",
};

export const formatDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
