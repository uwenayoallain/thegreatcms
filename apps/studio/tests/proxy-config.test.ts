/** The proxies shipped with the studio keep every preview out of search engines. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** A Caddyfile's top-level blocks: the line that opens each, and what is inside it. */
function blocks(file: string): Array<{ head: string; body: string }> {
  const found: Array<{ head: string; body: string }> = [];
  let open: { head: string; lines: string[] } | null = null;
  for (const line of readFileSync(join(ROOT, file), "utf8").split("\n")) {
    if (!open && /^\S.*\{$/.test(line)) open = { head: line, lines: [] };
    else if (open && line === "}") {
      found.push({ head: open.head, body: open.lines.join("\n") });
      open = null;
    } else open?.lines.push(line);
  }
  return found;
}

describe.each(["apps/studio/tunnel/Caddyfile", "examples/studio-astro/deploy/Caddyfile"])(
  "%s",
  (file) => {
    it("answers every preview with X-Robots-Tag: noindex, behind the studio's gate", () => {
      const previews = blocks(file).filter((block) =>
        /reverse_proxy previews?:4321/.test(block.body),
      );
      const hosts = previews.filter((block) => /PREVIEW_(DOMAIN|HOST)/.test(block.head));
      expect(hosts).toHaveLength(1);
      expect(hosts[0]!.body).toMatch(/^\theader X-Robots-Tag "noindex, nofollow"$/m);
      expect(hosts[0]!.body).toMatch(/import gate|forward_auth studio:8787/);
    });
  },
);
