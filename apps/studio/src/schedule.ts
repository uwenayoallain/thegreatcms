/** Times typed into a form, in the studio's time zone rather than the server's. */

/** The zone publish times are typed and shown in: STUDIO_TIMEZONE, else the server's own. */
export const studioTimeZone = () =>
  process.env.STUDIO_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function offsetAt(timestamp: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(timestamp));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return (
    Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) -
    timestamp
  );
}

/** `2026-10-14T09:30` as typed in `timeZone`, to a timestamp; null for anything else. */
export function zonedToEpoch(local: string, timeZone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Twice, because the offset at the guess can differ from the offset at the answer across a change.
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
}

export function formatInZone(timestamp: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}
