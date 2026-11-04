/** A date with a time survives the editor: shown as typed, saved as the same instant. */

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import type { BlockDef, FieldDef } from "@greatcms/spec";
import { decodeForm } from "../src/form.js";
import { hasRichText, renderFields } from "../src/views/fields.js";

const fields: Record<string, FieldDef> = {
  starts: { type: "date", time: true },
  day: { type: "date" },
};
const render = (values: Record<string, unknown>) =>
  new JSDOM(renderFields(fields, values, new Map()).join("")).window.document;
const value = (document: Document, selector: string) =>
  document.querySelector<HTMLInputElement>(selector)?.value;
const previousZone = process.env.STUDIO_TIMEZONE;
afterEach(() => {
  process.env.STUDIO_TIMEZONE = previousZone;
});

describe("a date field with a time", () => {
  it("is a date-and-time box showing the value's own wall time", () => {
    const page = render({ starts: "2026-11-20T18:00:00+02:00", day: "2026-11-20" });
    expect(value(page, 'input[type="datetime-local"][name="f[starts]"]')).toBe("2026-11-20T18:00");
    expect(value(page, 'input[type="hidden"][name="f[starts~zone]"]')).toBe("+02:00");
    expect(value(page, 'input[type="date"][name="f[day]"]')).toBe("2026-11-20");
  });

  it("saves the same instant it was loaded with", () => {
    expect(
      decodeForm(
        [
          ["f[starts]", "2026-11-20T18:00"],
          ["f[starts~zone]", "+02:00"],
          ["f[day]", "2026-11-20"],
        ],
        fields,
      ),
    ).toEqual({ starts: "2026-11-20T18:00:00+02:00", day: "2026-11-20" });
  });

  it("keeps a value that never had an offset free of one", () => {
    expect(value(render({ starts: "2026-11-20T18:00" }), '[name="f[starts~zone]"]')).toBe("local");
    expect(
      decodeForm(
        [
          ["f[starts]", "2026-11-20T19:30"],
          ["f[starts~zone]", "local"],
        ],
        fields,
      ),
    ).toEqual({ starts: "2026-11-20T19:30" });
  });

  it("gives a new value the studio's zone, so a build elsewhere reads the same time", () => {
    process.env.STUDIO_TIMEZONE = "Africa/Kigali";
    expect(decodeForm([["f[starts]", "2026-11-20T18:00"]], fields)).toEqual({
      starts: "2026-11-20T18:00:00+02:00",
    });
    process.env.STUDIO_TIMEZONE = "UTC";
    expect(decodeForm([["f[starts]", "2026-11-20T18:00"]], fields)).toEqual({
      starts: "2026-11-20T18:00:00Z",
    });
  });
});

describe("loading the rich-text editor", () => {
  const blocks: Record<string, BlockDef> = {
    step: { fields: { title: { type: "text" } } },
    process: { fields: { steps: { type: "blocks", allow: ["step"] } } },
    prose: { fields: { body: { type: "richtext" } } },
    nest: { fields: { children: { type: "blocks", allow: ["nest", "step"] } } },
  } as never;

  it("skips nested blocks that hold no rich text", () => {
    expect(hasRichText(blocks.process!.fields, new Set(), blocks)).toBe(false);
  });

  it("loads for a nested block that does, and finishes on a block that contains itself", () => {
    expect(
      hasRichText({ items: { type: "blocks", allow: ["step", "prose"] } }, new Set(), blocks),
    ).toBe(true);
    expect(hasRichText(blocks.nest!.fields, new Set(), blocks, new Set(["nest"]))).toBe(false);
  });
});
