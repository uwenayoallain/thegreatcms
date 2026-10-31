import { error } from "@sveltejs/kit";
import { essays } from "#lib/cms.js";

export function entries() {
  return essays().map((essay) => ({ slug: essay.slug }));
}

export function load({ params }) {
  const all = essays();
  const index = all.findIndex((essay) => essay.slug === params.slug);
  if (index === -1) error(404, "No essay by that name");
  return { essay: all[index], newer: all[index - 1] ?? null, older: all[index + 1] ?? null };
}
