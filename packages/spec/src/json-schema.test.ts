import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseConfig } from "./config.js";
import { SpecError } from "./errors.js";
import { parseSchema, unknownSchemaKeys } from "./schema.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const jsonSchema = (name: string) =>
  JSON.parse(readFileSync(join(ROOT, "packages/spec/json-schema", name), "utf8"));

const ajv = new Ajv({
  allErrors: true,
  strict: true,
  strictRequired: false,
  allowUnionTypes: true,
});
const schemaMatchesJsonSchema = ajv.compile(jsonSchema("schema.schema.json"));
const configMatchesJsonSchema = ajv.compile(jsonSchema("config.schema.json"));

/** Every `.cms` folder in the repository: the examples, the docs site, and the conformance fixture. */
const sites = [
  ...readdirSync(join(ROOT, "examples")).map((name) => `examples/${name}`),
  "apps/docs",
  "packages/conformance/fixtures",
].filter((dir) => existsSync(join(ROOT, dir, ".cms/schema.yaml")));

const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const field = (definition: string) => `version: 1
collections:
  people:
    path: content/people
    fields:
      name: { type: text }
regions:
  home.hero:
    fields:
      broken: ${definition}
`;

describe("the committed JSON Schemas agree with the parsers", () => {
  it("finds the sites it checks", () => {
    expect(sites.length).toBeGreaterThanOrEqual(4);
  });

  it.each(sites)("%s/.cms/schema.yaml passes both", (site) => {
    const source = read(`${site}/.cms/schema.yaml`);
    expect(() => parseSchema(source)).not.toThrow();
    expect(unknownSchemaKeys(source)).toEqual([]);
    expect(schemaMatchesJsonSchema(parseYaml(source)), errors(schemaMatchesJsonSchema)).toBe(true);
  });

  it.each(sites.filter((site) => existsSync(join(ROOT, site, ".cms/config.yaml"))))(
    "%s/.cms/config.yaml passes both",
    (site) => {
      const source = read(`${site}/.cms/config.yaml`);
      expect(() => parseConfig(source)).not.toThrow();
      expect(configMatchesJsonSchema(parseYaml(source)), errors(configMatchesJsonSchema)).toBe(
        true,
      );
    },
  );

  const VALID_SCHEMA = `version: 1
collections:
  people:
    path: content/people
    fields:
      name: { type: text, required: true }
regions:
  home.hero:
    fields:
      heading: { type: text, pattern: "^[A-Z]" }
      author: { type: reference, collection: people }
      team: { type: reference, collection: people, multiple: true, when: { field: heading, in: [A] } }
      tags: { type: list, of: { type: select, options: [a, { value: b, label: B }] } }
      seo: { type: group, fields: { title: { type: text } } }
`;

  it("accepts a schema using every kind of nesting", () => {
    expect(() => parseSchema(VALID_SCHEMA)).not.toThrow();
    expect(schemaMatchesJsonSchema(parseYaml(VALID_SCHEMA)), errors(schemaMatchesJsonSchema)).toBe(
      true,
    );
  });

  it.each([
    ["an unknown field type", field("{ type: paragraph }")],
    ["a field with no type", field("{ label: Heading }")],
    ["a select with no options", field("{ type: select, options: [] }")],
    ["a negative minimum length", field("{ type: text, min: -1 }")],
    ["a `when` with nothing to compare", field("{ type: text, when: { field: x } }")],
    ["a reference with no collection", field("{ type: reference }")],
    ["a list with no item type", field("{ type: list }")],
    ["an image with an unknown alt policy", field("{ type: image, alt: optional }")],
    ["a group with no fields", field("{ type: group }")],
    [
      "a blocks region that allows nothing",
      "version: 1\nregions:\n  a.b: { type: blocks, allow: [] }\n",
    ],
    [
      "a collection with no path",
      "version: 1\ncollections:\n  blog: { fields: { t: { type: text } } }\n",
    ],
    [
      "a collection in an unknown format",
      "version: 1\ncollections:\n  blog: { path: b, format: rst, fields: { t: { type: text } } }\n",
    ],
    ["a schema with no version", "regions:\n  a.b: { fields: { t: { type: text } } }\n"],
    ["a schema that manages nothing", "version: 1\n"],
    ["a region with no fields", "version: 1\nregions:\n  a.b: { fields: {} }\n"],
    [
      "a region id that is not a file name",
      "version: 1\nregions:\n  Home Hero: { fields: { t: { type: text } } }\n",
    ],
  ])("rejects %s in both", (_name, source) => {
    expect(() => parseSchema(source)).toThrow(SpecError);
    expect(schemaMatchesJsonSchema(parseYaml(source))).toBe(false);
  });

  it.each([
    ["a config with no version", "content: { regions: content/cms }\n"],
    ["a path that escapes the repository", "version: 1\ncontent: { regions: ../elsewhere }\n"],
    ["an absolute path", "version: 1\ncontent: { media: /srv/media }\n"],
    ["a preview path that is not text", "version: 1\npreview: { paths: { blog: 3 } }\n"],
    ["a commit message that is not text", "version: 1\npublish: { commitMessage: [a] }\n"],
  ])("rejects %s in both", (_name, source) => {
    expect(() => parseConfig(source)).toThrow(SpecError);
    expect(configMatchesJsonSchema(parseYaml(source))).toBe(false);
  });

  it("accepts sections left with only comments in both", () => {
    const source = "version: 1\ncontent:\npublish:\npreview:\n  # paths: {}\n";
    expect(() => parseConfig(source)).not.toThrow();
    expect(configMatchesJsonSchema(parseYaml(source)), errors(configMatchesJsonSchema)).toBe(true);
  });
});

function errors(validate: { errors?: unknown }): string {
  return JSON.stringify(validate.errors ?? [], null, 2);
}
