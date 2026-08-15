import { createReader } from "@greatcms/reader";

/** One reader for the whole site. */
export const cms = createReader({ root: new URL("../../", import.meta.url).pathname });

export interface Hero {
  heading: string;
  subtitle?: string;
  cta?: { href: string; label?: string };
}

export interface AboutIntro {
  heading: string;
  body: string;
}
