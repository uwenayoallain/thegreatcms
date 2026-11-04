/** The one place the site reads GreatCMS: at build time, or on every request in dev. */

import { createReader } from "@greatcms/reader";
import { marked } from "marked";
import type { WorkshopsEntry } from "../cms";

export const cms = createReader();

export type Workshop = Omit<WorkshopsEntry["data"], "details"> & {
  slug: string;
  full: boolean;
  html: string;
};

/** Every workshop, soonest first. */
export function workshops(): Workshop[] {
  return cms
    .collection("workshops")
    .map(({ slug, body, data }) => ({
      slug,
      title: data.title,
      summary: data.summary,
      date: data.date,
      length: data.length,
      level: data.level,
      price: data.price,
      seats: data.seats,
      image: data.image,
      full: Boolean(data.full),
      html: marked.parse(body, { async: false }),
    }))
    .toSorted((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

/** Upcoming ones only, so last month's class does not sit at the top of the page. */
export function upcoming(now = Date.now()): Workshop[] {
  return workshops().filter((workshop) => Date.parse(workshop.date) >= now - 86_400_000);
}

const KIGALI = "Africa/Kigali";

export function when(iso: string) {
  const date = new Date(iso);
  return {
    day: date.toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: KIGALI,
    }),
    short: date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: KIGALI }),
    time: date.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: KIGALI,
    }),
  };
}

export const francs = (amount: number) => `${new Intl.NumberFormat("en-GB").format(amount)} RWF`;

/** Where the studio receives this site's forms; set by `pnpm dev` and by your deploy. */
export function formAction(form: string) {
  const studio = (import.meta.env.PUBLIC_CMS_URL ?? "https://studio.ibumba.example").replace(
    /\/+$/,
    "",
  );
  const site = import.meta.env.PUBLIC_CMS_SITE_ID ?? "ibumba";
  return `${studio}/f/${encodeURIComponent(site)}/${form}`;
}
