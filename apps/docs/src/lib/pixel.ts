/** The studio's pixel face, for the one word this site sets in it. Drawn at build time as SVG rects. */

const GLYPHS: Record<string, string> = {
  A: ".####.|##..##|##..##|######|##..##|##..##|##..##",
  C: ".#####|##....|##....|##....|##....|##....|.#####",
  E: "######|##....|##....|#####.|##....|##....|######",
  G: ".#####|##....|##....|##.###|##..##|##..##|.#####",
  M: "##...##|###.###|#######|##.#.##|##...##|##...##|##...##",
  R: "#####.|##..##|##..##|#####.|##.##.|##..##|##..##",
  S: ".#####|##....|##....|.####.|....##|....##|#####.",
  T: "######|..##..|..##..|..##..|..##..|..##..|..##..",
};

const widthOf = (glyph: string) => glyph.indexOf("|");

/** Each run of ink in a row is one rect; the letters share one path per layer to keep the page small. */
function layer(letters: string[], starts: number[], shift: number): string {
  return letters
    .flatMap((glyph, index) =>
      glyph
        .split("|")
        .flatMap((row, r) =>
          [...row.matchAll(/#+/g)].map(
            (run) =>
              `M${(starts[index] ?? 0) + (run.index ?? 0) + shift} ${r + shift}h${run[0].length}v1h-${run[0].length}z`,
          ),
        ),
    )
    .join("");
}

/** A word in pixels, its shadow a quarter cell down and right. Sized by CSS; one unit is one cell. */
export function pixelWord(word: string): string {
  const letters = [...word.toUpperCase()].map((char) => GLYPHS[char] ?? GLYPHS.G) as string[];
  const starts = letters.map((_, index) =>
    letters.slice(0, index).reduce((x, glyph) => x + widthOf(glyph) + 1, 0),
  );
  const width = (starts.at(-1) ?? 0) + widthOf(letters.at(-1) ?? "");
  const shift = 0.25;
  return `<svg class="pixel-word" viewBox="0 0 ${width + shift} ${7 + shift}" role="img" aria-label="${word}"><path class="shadow" d="${layer(letters, starts, shift)}"/><path class="face" d="${layer(letters, starts, 0)}"/></svg>`;
}
