/** The terminal look: colour only when it is wanted, and the same words either way. */

import { describe, expect, it } from "vitest";
import { createUi, wantsColour } from "./ui.js";

describe("deciding on colour", () => {
  it("colours a terminal and nothing else", () => {
    expect(wantsColour({ isTTY: true }, {})).toBe(true);
    expect(wantsColour({ isTTY: false }, {})).toBe(false);
  });

  it("honours NO_COLOR and cli-kit's CK_PLAIN over a terminal", () => {
    expect(wantsColour({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
    expect(wantsColour({ isTTY: true }, { CK_PLAIN: "1" })).toBe(false);
    expect(wantsColour({ isTTY: true }, { TERM: "dumb" })).toBe(false);
  });
});

describe("painting", () => {
  it("prints the same marks and words in plain text, with no escapes", () => {
    const plain = createUi(false, {});
    expect(plain.ok("Built")).toBe("  ✓ Built");
    expect(plain.err("Broke\n  fix: retry")).toBe("  ✗ Broke\n      fix: retry");
    expect(plain.step("Next")).toMatch(/^● Next ─+$/);
  });

  it("follows the cli-kit flavour and accent", () => {
    const mocha = createUi(true, {}).accent("x");
    const frappe = createUi(true, { CK_FLAVOR: "frappe" }).accent("x");
    expect(mocha).toContain("\x1b[38;2;203;166;247m");
    expect(frappe).toContain("\x1b[38;2;202;158;230m");
    expect(createUi(true, { CK_ACCENT: "#89b4fa" }).accent("x")).toContain("38;2;137;180;250m");
  });
});
