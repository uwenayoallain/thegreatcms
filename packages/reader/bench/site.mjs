/** Writes a site to a temporary folder: a realistic schema, every region stored, thousands of entries. */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIELDS = [
  "heading: { type: text, required: true, max: 120, default: Hello }",
  "intro: { type: richtext }",
  "count: { type: number, default: 3 }",
  "shown: { type: boolean, default: true }",
  "tone: { type: select, options: [plain, loud], default: plain }",
  "cta: { type: link, default: { href: /about, label: About } }",
  "photo: { type: image, alt: decorative-allowed }",
  "seo: { type: group, fields: { title: { type: text, default: Meta }, index: { type: boolean, default: true } } }",
];

export function schemaSource(regions) {
  const out = ["version: 1", "site: { name: Bench }", "blocks:"];
  for (const name of ["hero", "text", "quote", "cta"]) {
    out.push(`  ${name}:`, "    fields:", ...FIELDS.map((field) => `      ${field}`));
  }
  out.push(
    "  grid:",
    "    fields:",
    "      cards: { type: blocks, allow: [text, quote], max: 6 }",
    "regions:",
  );
  for (let i = 0; i < regions; i++) {
    if (i % 4 === 0) {
      out.push(`  page${i}.body:`, "    type: blocks", "    allow: [hero, text, quote, cta, grid]");
    } else {
      out.push(`  page${i}.hero:`, "    fields:", ...FIELDS.map((field) => `      ${field}`));
    }
  }
  out.push("collections:");
  for (const name of ["blog", "notes", "people"]) {
    out.push(
      `  ${name}:`,
      `    path: content/${name}`,
      "    body: body",
      "    fields:",
      "      title: { type: text, required: true }",
      "      date: { type: date, required: true }",
      "      tags: { type: list, of: { type: text } }",
      "      draft: { type: boolean }",
      "      body: { type: richtext }",
    );
  }
  out.push(
    "  products:",
    "    path: content/products",
    "    format: json",
    "    fields:",
    "      title: { type: text, required: true }",
    "      price: { type: number }",
  );
  return `${out.join("\n")}\n`;
}

const block = (type, n) => ({
  _type: type,
  heading: `Heading ${n}`,
  intro: { html: "<p>Some <strong>rich</strong> text.</p>" },
  photo: { src: "/media/a.jpg", alt: "" },
});

/** Returns the site root. `entries` is per Markdown collection. */
export function writeSite({ regions = 60, entries = 1000 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "greatcms-bench-"));
  mkdirSync(join(root, ".cms"));
  mkdirSync(join(root, "content/cms"), { recursive: true });
  writeFileSync(join(root, ".cms/schema.yaml"), schemaSource(regions));
  writeFileSync(join(root, ".cms/config.yaml"), "version: 1\n");

  for (let i = 0; i < regions; i++) {
    const document =
      i % 4 === 0
        ? {
            blocks: Array.from({ length: 12 }, (_, n) =>
              n % 5 === 4
                ? { _type: "grid", cards: [block("text", n), block("quote", n)] }
                : block(["hero", "text", "quote", "cta"][n % 4], n),
            ),
          }
        : { heading: `Page ${i}`, intro: { html: "<p>Intro.</p>" }, count: i };
    const id = i % 4 === 0 ? `page${i}.body` : `page${i}.hero`;
    writeFileSync(join(root, `content/cms/${id}.json`), `${JSON.stringify(document, null, 2)}\n`);
  }

  const prose = "A paragraph of prose that stands in for a real article body. ".repeat(12);
  for (const name of ["blog", "notes", "people"]) {
    mkdirSync(join(root, "content", name));
    for (let i = 0; i < entries; i++) {
      writeFileSync(
        join(root, "content", name, `entry-${String(i).padStart(5, "0")}.md`),
        `---\ntitle: "Entry number ${i}: a title"\ndate: 2026-08-12\ntags: [release, notes, n${i % 7}]\ndraft: false\n---\n\n# Entry ${i}\n\n${prose}\n`,
      );
    }
  }
  mkdirSync(join(root, "content/products"));
  for (let i = 0; i < entries; i++) {
    writeFileSync(
      join(root, "content/products", `product-${i}.json`),
      `${JSON.stringify({ price: i, title: `Product ${i}` }, null, 2)}\n`,
    );
  }
  return root;
}
