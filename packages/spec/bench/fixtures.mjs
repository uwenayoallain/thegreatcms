/** Builds a large schema and matching content in memory, so every bench measures the same site. */

const FIELD_KINDS = [
  (i) => `{ type: text, required: true, max: 120, pattern: '^[^<>]*$', default: "Heading ${i}" }`,
  () => `{ type: richtext }`,
  () => `{ type: number, min: 0, max: 1000, default: 3 }`,
  () => `{ type: boolean, default: false }`,
  () =>
    `{ type: select, options: [draft, live, { value: archived, label: Archived }], default: draft }`,
  () => `{ type: date }`,
  () => `{ type: link, default: { href: "/about", label: About } }`,
  () => `{ type: image, alt: decorative-allowed }`,
  () => `{ type: list, of: { type: text }, max: 50 }`,
  () =>
    `{ type: group, fields: { title: { type: text, default: Meta }, robots: { type: boolean, default: true } } }`,
];

function fields(indent, count, offset = 0) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(`${indent}f${i}: ${FIELD_KINDS[(i + offset) % FIELD_KINDS.length](i)}`);
  }
  return lines.join("\n");
}

/** `size` blocks, regions and collections each; ten fields apiece. */
export function schemaSource(size = 300) {
  const out = ["version: 1", "site: { name: Bench, locale: en }", "blocks:"];
  for (let i = 0; i < size; i++) {
    out.push(`  block${i}:`, `    label: Block ${i}`, "    fields:", fields("      ", 10, i));
    if (i % 3 === 0)
      out.push(`      children: { type: blocks, allow: [block${(i + 1) % size}], max: 4 }`);
  }
  out.push("regions:");
  for (let i = 0; i < size; i++) {
    if (i % 4 === 0) {
      out.push(
        `  page${i}.body:`,
        "    type: blocks",
        `    allow: [block${i}, block${(i + 1) % size}]`,
      );
    } else {
      out.push(
        `  page${i}.hero:`,
        "    fields:",
        fields("      ", 10, i),
        "    default: { f0: Hello }",
      );
    }
  }
  out.push("collections:");
  for (let i = 0; i < size; i++) {
    out.push(
      `  col${i}:`,
      `    path: content/col${i}`,
      "    body: body",
      "    fields:",
      "      title: { type: text, required: true }",
      "      date: { type: date }",
      "      tags: { type: list, of: { type: text } }",
      "      body: { type: richtext }",
    );
  }
  return `${out.join("\n")}\n`;
}

const VALUES = [
  (i) => `Heading ${i}`,
  () => ({ html: "<p>Some <strong>rich</strong> text that goes on for a little while.</p>" }),
  (i) => i % 1000,
  (i) => i % 2 === 0,
  () => "live",
  () => "2026-08-12",
  () => ({ href: "/about", label: "About" }),
  () => ({ src: "/media/a.jpg", alt: "", width: 800, height: 600 }),
  () => ["one", "two", "three"],
  () => ({ title: "Meta" }),
];

export function fieldValues(offset = 0, count = 10) {
  const out = {};
  for (let i = 0; i < count; i++) out[`f${i}`] = VALUES[(i + offset) % VALUES.length](i);
  return out;
}

/** A blocks document `count` long, every third block holding nested blocks. */
export function blocksDocument(regionIndex, size, count = 200) {
  const blocks = [];
  for (let n = 0; n < count; n++) {
    const type = n % 2 === 0 ? regionIndex : (regionIndex + 1) % size;
    const block = { _type: `block${type}`, ...fieldValues(type) };
    if (type % 3 === 0) {
      const child = (type + 1) % size;
      block.children = [{ _type: `block${child}`, ...fieldValues(child) }];
    }
    blocks.push(block);
  }
  return { blocks };
}

export function entrySource(i) {
  const prose = "A paragraph of prose that stands in for a real article body. ".repeat(12);
  return `---\ntitle: "Entry number ${i}: a title"\ndate: 2026-08-12\ntags: [release, notes, n${i % 7}]\n---\n\n# Entry ${i}\n\n${prose}\n`;
}

/** Median of `runs` timings of `fn`, in milliseconds, after one warm-up call. */
export function time(fn, runs = 7) {
  fn();
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

export function report(rows) {
  const width = Math.max(...rows.map(([name]) => name.length));
  for (const [name, ms] of rows)
    console.log(`${name.padEnd(width)}  ${ms.toFixed(2).padStart(9)} ms`);
}
