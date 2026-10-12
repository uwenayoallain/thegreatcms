/** The language the studio's own chrome speaks and formats dates in; content has its own, per site. */

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
