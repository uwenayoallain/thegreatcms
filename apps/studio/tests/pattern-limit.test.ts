/** A schema's `pattern` that V8 cannot run in linear time is stopped, and the field says so. */

import { parseSchema, usePatternMatcher, validateRegion } from "@greatcms/spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundedMatch, runsInLinearTime } from "../src/patterns.js";
import { type Fixture, get, makeSite, post, SITE_ID } from "./site.js";

const SCHEMA = `version: 1
regions:
  home.hero:
    fields:
      lookahead: { type: text, pattern: "^(?=(a+)+$)" }
      backreference: { type: text, pattern: "^(a+)+\\\\1$" }
      counted: { type: text, pattern: "^(a+){20}$" }
      slug: { type: text, pattern: "^[a-z0-9-]{1,63}$" }
      strong: { type: text, pattern: "^(?=.*[0-9])(?=.*[a-z]).{8,}$" }
      many: { type: list, of: { type: text, pattern: "^(?=(a+)+$)" } }
`;
/** Long enough that backtracking would outlast the test many times over. */
const HOSTILE = `${"a".repeat(64)}!`;
/** Generous: a hang is minutes, and a slow machine must not fail this. */
const PROMPT_MS = 20_000;

let site: Fixture;

beforeEach(() => {
  site = makeSite({ schema: SCHEMA });
});
afterEach(() => site.cleanup());

const publish = (fields: Record<string, string>) =>
  post(site, `/sites/${SITE_ID}/regions/home.hero`, {
    headSha: site.head(),
    action: "publish",
    ...fields,
  });

describe("a pattern the linear-time engine cannot run", () => {
  it.each(["lookahead", "backreference", "counted"])(
    "is stopped for a value that would hang a %s",
    async (field) => {
      const began = Date.now();
      const answer = await publish({ [`f[${field}]`]: HOSTILE });

      expect(answer.status).toBe(422);
      expect(await answer.text()).toContain("in time, so it was not accepted");
      expect(Date.now() - began).toBeLessThan(PROMPT_MS);
    },
  );

  it("is never handed to the browser, where it would hang the editor's own tab", async () => {
    const page = await (await get(site, `/sites/${SITE_ID}/regions/home.hero`)).text();

    expect(page).toContain('name="f[lookahead]"');
    expect(page).not.toMatch(/\spattern=/);
  });

  it("does not add up over a long list", async () => {
    const fields = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`f[many][${index}]`, HOSTILE]),
    );
    const began = Date.now();
    const answer = await publish(fields);

    expect(answer.status).toBe(422);
    expect(Date.now() - began).toBeLessThan(PROMPT_MS);
  });

  it("still checks ordinary values, with the same answers as before", async () => {
    const good = await publish({
      "f[lookahead]": "aaaa",
      "f[counted]": "a".repeat(20),
      "f[slug]": "a-fine-slug",
      "f[strong]": "passw0rd1",
    });
    expect(good.status).toBe(200);

    const bad = await (await publish({ "f[slug]": "Not A Slug", "f[strong]": "short" })).text();
    expect(bad).toContain("Does not match required pattern ^[a-z0-9-]{1,63}$");
    expect(bad).toContain("Does not match required pattern ^(?=.*[0-9])(?=.*[a-z]).{8,}$");
    expect(bad).not.toContain("in time");
  });

  it("accepts every pattern the schema could have before", () => {
    // Refusing these at parse would turn working sites away, so they are limited instead.
    expect(() => parseSchema(SCHEMA)).not.toThrow();
  });

  it("knows which patterns need the limit", () => {
    expect(runsInLinearTime(/^(a+)+$/)).toBe(true);
    expect(runsInLinearTime(/^[A-Z]/)).toBe(true);
    expect(runsInLinearTime(/^(?=(a+)+$)/)).toBe(false);
    expect(runsInLinearTime(/(a)\1/)).toBe(false);
    // An everyday repeat count is one of them, which is why such patterns are not refused.
    expect(runsInLinearTime(/^[a-z0-9-]{1,63}$/)).toBe(false);
    expect(boundedMatch(/^[a-z0-9-]{1,63}$/, "fine")).toBe(true);
    expect(boundedMatch(/^[a-z0-9-]{1,63}$/, "Not fine")).toBe(false);
    expect(boundedMatch(/^(?=(a+)+$)/, HOSTILE)).toBeNull();
  });
});

describe("outside the studio", () => {
  it("a pattern is simply tested, as a build and the command line do", () => {
    const schema = parseSchema(SCHEMA);
    usePatternMatcher(undefined);
    try {
      expect(validateRegion(schema, "home.hero", { slug: "fine" }).ok).toBe(true);
      expect(validateRegion(schema, "home.hero", { slug: "Not fine" }).issues[0]?.code).toBe(
        "pattern_mismatch",
      );
      usePatternMatcher(() => null);
      expect(validateRegion(schema, "home.hero", { slug: "fine" }).issues[0]?.code).toBe(
        "pattern_timeout",
      );
    } finally {
      usePatternMatcher(boundedMatch);
    }
  });
});
