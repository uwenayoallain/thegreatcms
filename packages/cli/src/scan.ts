/** What `check` reads out of rich text: images, links and headings, in document order. */

export interface ScannedText {
  images: string[];
  /** `text` is `null` when the syntax gives no way to know it, as with a reference definition. */
  links: Array<{ href: string; text: string | null }>;
  headings: number[];
}

/** Rich text stored as HTML, the shape a richtext field holds in a data file. */
export function scanHtml(html: string): ScannedText {
  return collect(stripHtmlNoise(html), false);
}

/** A Markdown or MDX body, which may also carry inline HTML. */
export function scanMarkdown(markdown: string): ScannedText {
  return collect(stripMarkdownNoise(stripHtmlNoise(markdown)), true);
}

/** Heading levels that jump more than one step down, as `[from, to]` pairs. */
export function skippedHeadings(levels: readonly number[]): Array<[number, number]> {
  const skips: Array<[number, number]> = [];
  for (let i = 1; i < levels.length; i += 1) {
    const previous = levels[i - 1] as number;
    const level = levels[i] as number;
    if (level > previous + 1) skips.push([previous, level]);
  }
  return skips;
}

function collect(source: string, markdown: boolean): ScannedText {
  const found: Array<{
    at: number;
    image?: string;
    link?: ScannedText["links"][number];
    heading?: number;
  }> = [];

  for (const match of source.matchAll(/<img\b([^>]*)>/gi)) {
    const src = attribute(match[1] ?? "", "src");
    if (src) found.push({ at: match.index, image: src });
  }
  for (const match of source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attrs = match[1] ?? "";
    const href = attribute(attrs, "href");
    if (href === null) continue;
    const label = attribute(attrs, "aria-label") ?? attribute(attrs, "title") ?? "";
    found.push({
      at: match.index,
      link: { href, text: `${label} ${htmlText(match[2] ?? "")}`.trim() },
    });
  }
  for (const match of source.matchAll(/<h([1-6])\b/gi)) {
    found.push({ at: match.index, heading: Number(match[1]) });
  }

  if (markdown) {
    for (const match of source.matchAll(/^ {0,3}(#{1,6})(?:[ \t]|$)/gm)) {
      found.push({ at: match.index, heading: (match[1] as string).length });
    }
    // An image inside a link's text is its text, so images are read first and blanked out.
    const image = /!\[([^\]]*)\]\(\s*<?([^\s)>]*)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
    for (const match of source.matchAll(image)) {
      if (match[2]) found.push({ at: match.index, image: match[2] });
    }
    const withoutImages = source.replace(image, (_whole, alt: string) => ` ${alt} `);
    const link =
      /(?<![!\\])\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*<?([^\s)>]*)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
    for (const match of withoutImages.matchAll(link)) {
      const href = match[2] ?? "";
      if (href === "") continue;
      found.push({
        at: match.index,
        link: {
          href,
          text: htmlText(match[1] ?? "")
            .replace(/[*_~]/g, "")
            .trim(),
        },
      });
    }
    for (const match of source.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)) {
      found.push({ at: match.index, link: { href: match[1] as string, text: null } });
    }
  }

  found.sort((a, b) => a.at - b.at);
  return {
    images: found.flatMap((item) => (item.image === undefined ? [] : [decodeEntities(item.image)])),
    links: found.flatMap((item) =>
      item.link ? [{ href: decodeEntities(item.link.href), text: item.link.text }] : [],
    ),
    headings: found.flatMap((item) => (item.heading === undefined ? [] : [item.heading])),
  };
}

/** Comments and preformatted blocks hold examples, not content: a `# comment` there is not a heading. */
function stripHtmlNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, (whole) => blank(whole))
    .replace(/<(pre|script|style)\b[\s\S]*?<\/\1\s*>/gi, (whole) => blank(whole));
}

function stripMarkdownNoise(markdown: string): string {
  const lines = markdown.split("\n");
  let fence: string | null = null;
  const kept = lines.map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return "";
    }
    if (marker) {
      fence = marker;
      return "";
    }
    return line;
  });
  // Inline code keeps a placeholder, so a link whose text is code still has text.
  return kept
    .join("\n")
    .replace(/(`+)[^`]*?\1/g, (whole) => `code${" ".repeat(Math.max(0, whole.length - 4))}`);
}

/** Keeps offsets stable, so document order survives the stripping. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i",
  ).exec(attrs);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? "";
}

/** The text a reader or a screen reader gets: tags dropped, an image standing in as its alt. */
function htmlText(html: string): string {
  return decodeEntities(
    html
      .replace(/<img\b([^>]*)>/gi, (_whole, attrs: string) => ` ${attribute(attrs, "alt") ?? ""} `)
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_whole, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}
