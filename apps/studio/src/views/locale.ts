/** The language the studio's own chrome speaks and formats dates in; content has its own, per site. */

import { html } from "hono/html";
import { chrome } from "./chrome.js";

let current = "en";

export function setLocale(tag: string): void {
  // A bad tag would throw on every date; fall back rather than fail every screen.
  try {
    current = new Intl.DateTimeFormat(tag).resolvedOptions().locale;
  } catch {
    current = "en";
  }
}

export function locale(): string {
  return current;
}

/** The zone times are shown in: the studio's, the same one "publish later" is typed in. */
const zone = () => chrome().timeZone ?? "UTC";

/** SQLite's `datetime('now')` is UTC without a zone marker; read as that, shown in the studio's zone. */
export function when(stored: string) {
  const date = new Date(
    /[zZ]|[+-]\d\d:\d\d$/.test(stored) ? stored : `${stored.replace(" ", "T")}Z`,
  );
  if (Number.isNaN(date.getTime())) return html`${stored}`;
  const label = date.toLocaleString(locale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: zone(),
    timeZoneName: "short",
  });
  return html`<time datetime="${date.toISOString()}">${label}</time>`;
}

const STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 86_400],
  ["month", 30 * 86_400],
  ["week", 7 * 86_400],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** "3 days ago", with the exact moment on hover; recent work reads better relative. */
/** Building an Intl formatter costs far more than using one, and a history page uses dozens. */
const formatterCache = new Map<
  string,
  { relative: Intl.RelativeTimeFormat; exact: Intl.DateTimeFormat }
>();
function formatters(tag: string, timeZone: string) {
  const key = `${tag} ${timeZone}`;
  let found = formatterCache.get(key);
  if (!found) {
    found = {
      relative: new Intl.RelativeTimeFormat(tag, { numeric: "auto" }),
      exact: new Intl.DateTimeFormat(tag, {
        dateStyle: "medium",
        timeStyle: "long",
        timeZone,
      }),
    };
    formatterCache.set(key, found);
  }
  return found;
}

export function ago(stored: string, now = Date.now()) {
  const date = new Date(stored);
  if (Number.isNaN(date.getTime())) return html`${stored}`;
  const seconds = Math.round((date.getTime() - now) / 1000);
  const [unit, size] = STEPS.find(([, span]) => Math.abs(seconds) >= span) ?? ["second", 1];
  const label =
    unit === "second"
      ? "just now"
      : formatters(locale(), zone()).relative.format(Math.round(seconds / size), unit);
  const exact = formatters(locale(), zone()).exact.format(date);
  return html`<time datetime="${date.toISOString()}" title="${exact}">${label}</time>`;
}
