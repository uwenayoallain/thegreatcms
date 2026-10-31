/**
 * The terminal look, shared with cli-kit: Catppuccin, one accent, the same marks.
 * `CK_FLAVOR`, `CK_ACCENT`, `CK_PLAIN` and `NO_COLOR` mean what they mean there.
 */

const FLAVORS = {
  mocha: {
    mauve: "#cba6f7",
    red: "#f38ba8",
    yellow: "#f9e2af",
    green: "#a6e3a1",
    blue: "#89b4fa",
    lavender: "#b4befe",
    overlay: "#6c7086",
  },
  frappe: {
    mauve: "#ca9ee6",
    red: "#e78284",
    yellow: "#e5c890",
    green: "#a6d189",
    blue: "#8caaee",
    lavender: "#babbf1",
    overlay: "#737994",
  },
} as const;

type Env = Record<string, string | undefined>;

/** A status line: indented mark, then the text, continuation lines under the text. */
const mark = (glyph: string, paint: (text: string) => string) => (text: string) =>
  `  ${paint(glyph)} ${text.replace(/\n/g, "\n    ")}`;

export interface Ui {
  readonly colour: boolean;
  ok(text: string): string;
  info(text: string): string;
  warn(text: string): string;
  err(text: string): string;
  /** Secondary detail, indented and muted. */
  note(text: string): string;
  /** A section header: `● Title ─────`. */
  step(title: string): string;
  /** Aligned key/value rows. */
  kv(rows: Array<[string, string]>): string;
  accent(text: string): string;
  muted(text: string): string;
  bold(text: string): string;
}

/** Colour only for a person at a terminal who has not asked for plain text. */
export function wantsColour(stream: { isTTY?: boolean }, env: Env = process.env): boolean {
  if (env.NO_COLOR || env.CK_PLAIN) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  return Boolean(stream.isTTY);
}

export function createUi(colour: boolean, env: Env = process.env): Ui {
  const palette = env.CK_FLAVOR?.startsWith("frapp") ? FLAVORS.frappe : FLAVORS.mocha;
  const accentHex = /^#[0-9a-f]{6}$/i.test(env.CK_ACCENT ?? "") ? env.CK_ACCENT! : palette.mauve;
  const fg = (hex: string) => (text: string) => {
    if (!colour) return text;
    const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
  };
  const bold = (text: string) => (colour ? `\x1b[1m${text}\x1b[22m` : text);
  const accent = fg(accentHex);
  const muted = fg(palette.overlay);

  return {
    colour,
    ok: mark("✓", fg(palette.green)),
    info: mark("→", fg(palette.blue)),
    warn: mark("!", fg(palette.yellow)),
    err: mark("✗", fg(palette.red)),
    note: (text) => muted(`  ${text.replace(/\n/g, "\n  ")}`),
    step(title) {
      const width = Math.min(process.stdout.columns || 80, 80);
      const rule = "─".repeat(Math.max(0, width - title.length - 4));
      return `${bold(accent("●"))} ${bold(title)} ${muted(rule)}`;
    },
    kv(rows) {
      const width = Math.max(10, ...rows.map(([key]) => key.length));
      return rows.map(([key, value]) => `  ${muted(key.padEnd(width))}  ${value}`).join("\n");
    },
    accent,
    muted,
    bold,
  };
}

/** For callers with no terminal in mind: tests, `--json` neighbours, library use. */
export const plainUi: Ui = createUi(false, {});

let active: Ui = plainUi;

/** Set once per run, by `run()`; everything that formats output reads it. */
export function useUi(next: Ui): void {
  active = next;
}

export function ui(): Ui {
  return active;
}
