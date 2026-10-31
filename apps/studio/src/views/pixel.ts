/** Pixel lettering: a site without a favicon gets its initial in a bold seven-row pixel face, drawn server-side as SVG. */

import { html, raw } from "hono/html";

/** A bold pixel face, seven rows tall, strokes two cells wide; `#` is ink. Anything else falls back to a dot. */
const GLYPHS: Record<string, string> = {
  A: ".####.|##..##|##..##|######|##..##|##..##|##..##",
  B: "#####.|##..##|##..##|#####.|##..##|##..##|#####.",
  C: ".#####|##....|##....|##....|##....|##....|.#####",
  D: "#####.|##..##|##..##|##..##|##..##|##..##|#####.",
  E: "######|##....|##....|#####.|##....|##....|######",
  F: "######|##....|##....|#####.|##....|##....|##....",
  G: ".#####|##....|##....|##.###|##..##|##..##|.#####",
  H: "##..##|##..##|##..##|######|##..##|##..##|##..##",
  I: "######|..##..|..##..|..##..|..##..|..##..|######",
  J: "..####|....##|....##|....##|....##|##..##|.####.",
  K: "##..##|##.##.|####..|###...|####..|##.##.|##..##",
  L: "##....|##....|##....|##....|##....|##....|######",
  M: "##...##|###.###|#######|##.#.##|##...##|##...##|##...##",
  N: "##..##|###.##|######|##.###|##..##|##..##|##..##",
  O: ".####.|##..##|##..##|##..##|##..##|##..##|.####.",
  P: "#####.|##..##|##..##|#####.|##....|##....|##....",
  Q: ".####.|##..##|##..##|##..##|##.###|.####.|....##",
  R: "#####.|##..##|##..##|#####.|##.##.|##..##|##..##",
  S: ".#####|##....|##....|.####.|....##|....##|#####.",
  T: "######|..##..|..##..|..##..|..##..|..##..|..##..",
  U: "##..##|##..##|##..##|##..##|##..##|##..##|.####.",
  V: "##..##|##..##|##..##|##..##|##..##|.####.|..##..",
  W: "##...##|##...##|##...##|##.#.##|#######|###.###|##...##",
  X: "##..##|##..##|.####.|..##..|.####.|##..##|##..##",
  Y: "##..##|##..##|.####.|..##..|..##..|..##..|..##..",
  Z: "######|....##|...##.|..##..|.##...|##....|######",
  "0": ".####.|##..##|##.###|######|###.##|##..##|.####.",
  "1": "..##..|.###..|..##..|..##..|..##..|..##..|.####.",
  "2": ".####.|##..##|....##|...##.|..##..|.##...|######",
  "3": "#####.|....##|....##|.####.|....##|....##|#####.",
  "4": "...##.|..###.|.####.|##.##.|######|...##.|...##.",
  "5": "######|##....|#####.|....##|....##|##..##|.####.",
  "6": ".####.|##....|##....|#####.|##..##|##..##|.####.",
  "7": "######|....##|...##.|..##..|.##...|.##...|.##...",
  "8": ".####.|##..##|##..##|.####.|##..##|##..##|.####.",
  "9": ".####.|##..##|##..##|.#####|....##|....##|.####.",
  "·": "......|......|......|..##..|......|......|......",
};

const widthOf = (glyph: string) => glyph.indexOf("|");

/** Face and shadow, the two-ink pixel letter of the owner's other work; chosen by name, so a site keeps its colour. */
const INKS: ReadonlyArray<readonly [string, string]> = [
  ["#f4d619", "#2f5f9e"],
  ["#1fbf8a", "#0b4a3a"],
  ["#eacaaf", "#7a4f8f"],
  ["#a78bfa", "#3a2b78"],
  ["#7fb2ec", "#1d3a66"],
  ["#f3f3f3", "#0d7a5f"],
];

/** Each run of ink in a row becomes one rect, so a glyph is a handful of shapes. */
function rects(glyph: string, cell: number, x0: number, y0: number, fill: string): string {
  return glyph
    .split("|")
    .flatMap((row, r) =>
      [...row.matchAll(/#+/g)].map(
        (run) =>
          `<rect x="${x0 + (run.index ?? 0) * cell}" y="${y0 + r * cell}" width="${run[0].length * cell}" height="${cell}" fill="${fill}"/>`,
      ),
    )
    .join("");
}

function hash(text: string): number {
  let h = 2166136261;
  for (const char of text) h = Math.imul(h ^ (char.codePointAt(0) ?? 0), 16777619);
  return h >>> 0;
}

/** The first letter or digit of a name, the way the studio's own mark is a letter. */
export function initialOf(name: string): string {
  const letter = [...name.normalize("NFD").toUpperCase()].find((char) => GLYPHS[char]);
  return letter ?? "·";
}

/**
 * A site's tile as a standalone SVG: its own favicon on a light square, or, without one, its
 * initial in pixels on a dark one, the shadow half a cell down and right. One image either way,
 * so every screen shows a site the same way.
 */
export function siteTile(name: string, favicon?: { type: string; bytes: Uint8Array }): string {
  const open =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40" shape-rendering="crispEdges">';
  if (favicon) {
    const data = `data:${favicon.type};base64,${Buffer.from(favicon.bytes).toString("base64")}`;
    return `${open}<rect width="40" height="40" fill="#fff"/><image href="${data}" x="7" y="7" width="26" height="26"/></svg>`;
  }
  const glyph = GLYPHS[initialOf(name)] as string;
  const [face, shadow] = INKS[hash(name) % INKS.length] as readonly [string, string];
  // The glyph and its shadow, centred in the 40-unit tile at 3.5 units a cell.
  const cell = 3.5;
  const x = (40 - widthOf(glyph) * cell - 2) / 2;
  const y = (40 - 7 * cell - 2) / 2;
  return `${open}<rect width="40" height="40" fill="#15171a"/>${rects(glyph, cell, x + 2, y + 2, shadow)}${rects(glyph, cell, x, y, face)}</svg>`;
}

/** The tile as the studio shows it: decorative, since the site's name always sits beside it. */
export function siteAvatar(siteId: string, className = "avatar") {
  return html`<img
    class="${className}"
    src="/sites/${siteId}/icon"
    alt=""
    width="40"
    height="40"
  />`;
}

/** A person's initial on the same tile, inline: people have no favicon to look for. */
export function personAvatar(name: string) {
  return raw(siteTile(name).replace("<svg ", '<svg class="avatar person" aria-hidden="true" '));
}

/** A word set in the same pixels, for the sign-in screen's wordmark. */
export function pixelWord(word: string, options: { face: string; shadow: string; label: string }) {
  const cell = 4;
  const offset = 3;
  const letters = [...word.toUpperCase()].map((char) => GLYPHS[char] ?? GLYPHS["·"]) as string[];
  // Each letter at its own width, one cell apart.
  const starts = letters.map((_, index) =>
    letters.slice(0, index).reduce((x, glyph) => x + (widthOf(glyph) + 1) * cell, 0),
  );
  const width = (starts.at(-1) ?? 0) + widthOf(letters.at(-1) ?? "") * cell + offset;
  const height = 7 * cell + offset;
  const layer = (fill: string, shift: number) =>
    letters
      .map((glyph, index) => rects(glyph, cell, (starts[index] ?? 0) + shift, shift, fill))
      .join("");
  return html`${raw(
    `<svg class="pixel-word" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges" role="img" aria-label="${options.label}"><g>${layer(options.shadow, offset)}</g><g class="face">${layer(options.face, 0)}</g></svg>`,
  )}`;
}
