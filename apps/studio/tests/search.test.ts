import { describe, expect, it } from "vitest";
import { findFolded, snippet } from "../src/search.js";
import { entryTitle } from "../src/sites.js";

describe("finding a word", () => {
  it("ignores case and accents and returns the range in the original text", () => {
    const text = "Our Café opens at nine";
    const [start, end] = findFolded(text, "cafe")!;
    expect(text.slice(start, end)).toBe("Café");
  });

  it("keeps the range right when folding changes the length before the match", () => {
    // "İ" lowercases to two characters, and a decomposed accent folds to none.
    const text = "İstanbul and Café Kigali";
    const [start, end] = findFolded(text, "kigali")!;
    expect(text.slice(start, end)).toBe("Kigali");
    const [cafeStart, cafeEnd] = findFolded(text, "café")!;
    expect(text.slice(cafeStart, cafeEnd)).toBe("Café");
  });

  it("finds nothing when the word is not there", () => {
    expect(findFolded("Clay and glaze", "kiln")).toBeUndefined();
  });
});

describe("the words around a match", () => {
  it("cuts back to whole words on both sides", () => {
    const text =
      "Bisque first, then two firings: one to harden it, and one to melt the glaze into glass. The kiln decides the rest of the evening for everyone.";
    const at = text.indexOf("glaze");
    const { before, match, after } = snippet(text, at, at + 5, 20, 20);
    expect(match).toBe("glaze");
    expect(before).toBe("…one to melt the ");
    expect(after).toBe(" into glass. The…");
  });

  it("adds no ellipsis when the whole text fits", () => {
    expect(snippet("Fired slowly", 0, 5)).toEqual({ before: "", match: "Fired", after: " slowly" });
  });
});

describe("an entry's title", () => {
  it("uses the slug field, then a title or name, then the slug", () => {
    const collection = { path: "content/w", fields: {}, slug: "heading" } as never;
    expect(entryTitle(collection, { heading: "Raku afternoon" }, "raku")).toBe("Raku afternoon");
    expect(entryTitle(undefined, { name: "Aline" }, "aline")).toBe("Aline");
    expect(entryTitle(undefined, { title: "  " }, "blank-title")).toBe("blank-title");
    expect(entryTitle(undefined, { title: { html: "<p>x</p>" } }, "rich")).toBe("rich");
  });
});
