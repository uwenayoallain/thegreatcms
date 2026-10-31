import { cms, essays } from "#lib/cms.js";

export function load() {
  const all = essays();
  const lead = all.find((essay) => essay.featured) ?? all[0];
  return {
    intro: cms().region("home.intro"),
    lead,
    rest: all.filter((essay) => essay !== lead),
  };
}
