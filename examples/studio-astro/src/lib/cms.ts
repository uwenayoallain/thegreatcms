import { createReader } from "@greatcms/reader";

// The build runs from the site's folder, which holds .cms/.
export const cms = createReader();

/** Projects in the order the studio set, newest first among equals. */
export function projects() {
  return cms
    .collection("work")
    .toSorted(
      (a, b) =>
        (a.data.order ?? 10) - (b.data.order ?? 10) || (b.data.year ?? 0) - (a.data.year ?? 0),
    );
}

/** "140+" → { number: 140, before: "", after: "+" }, so a figure can count up and still read as written. */
export function figure(value: string) {
  const match = /^(\D*)(\d+)(.*)$/.exec(value.trim());
  return match
    ? { number: Number(match[2]), digits: match[2]!.length, before: match[1]!, after: match[3]! }
    : null;
}
