import { cms } from "#lib/cms.js";

export function load() {
  return { about: cms().region("about.page") };
}
