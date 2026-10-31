/** A time typed in the studio's zone means that moment, not the server's idea of it. */

import { describe, expect, it } from "vitest";
import { formatInZone, zonedToEpoch } from "../src/schedule.js";

describe("publish times", () => {
  it("reads a typed time in the studio's zone", () => {
    expect(new Date(zonedToEpoch("2026-10-14T09:30", "Africa/Kigali")!).toISOString()).toBe(
      "2026-10-14T07:30:00.000Z",
    );
    expect(new Date(zonedToEpoch("2026-10-14T09:30", "UTC")!).toISOString()).toBe(
      "2026-10-14T09:30:00.000Z",
    );
  });

  it("gets the hour right on either side of a clock change", () => {
    // Paris moved from UTC+2 to UTC+1 on 25 October 2026.
    expect(new Date(zonedToEpoch("2026-10-24T12:00", "Europe/Paris")!).toISOString()).toBe(
      "2026-10-24T10:00:00.000Z",
    );
    expect(new Date(zonedToEpoch("2026-10-26T12:00", "Europe/Paris")!).toISOString()).toBe(
      "2026-10-26T11:00:00.000Z",
    );
  });

  it("refuses anything that is not a datetime-local value, and formats back in the zone", () => {
    expect(zonedToEpoch("tomorrow", "UTC")).toBeNull();
    expect(formatInZone(Date.UTC(2026, 9, 14, 7, 30), "Africa/Kigali")).toContain("09:30");
  });
});
