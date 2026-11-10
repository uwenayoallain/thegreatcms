/** The starting points `init` offers; data only, so help text can list them without loading `init`. */

export type TemplateId = "hero" | "landing" | "business" | "blog" | "blank";

export interface Template {
  id: TemplateId;
  label: string;
  hint: string;
}

export const TEMPLATES: Template[] = [
  {
    id: "hero",
    label: "One managed region",
    hint: "a hero section: the rest of the page stays code",
  },
  {
    id: "landing",
    label: "Landing page",
    hint: "hero plus a reorderable block list of features, text, and CTAs",
  },
  {
    id: "business",
    label: "Business website",
    hint: "company details, contact info, products, and flexible page sections",
  },
  {
    id: "blog",
    label: "Blog",
    hint: "a Markdown collection with a managed intro region",
  },
  { id: "blank", label: "Blank", hint: "config only: you write the regions" },
];
