import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isNewer, updateCommand, updateNotice } from "./update.js";

let dir: string;
let asked: number;
const answers = (version: unknown, status = 200): typeof fetch => {
  return async () => {
    asked++;
    return new Response(JSON.stringify({ version }), { status });
  };
};
const check = (extra: Partial<Parameters<typeof updateNotice>[0]> = {}) =>
  updateNotice({
    current: "0.1.3",
    cwd: dir,
    interactive: true,
    env: {},
    cacheFile: join(dir, "cache", "update.json"),
    fetcher: answers("0.2.0"),
    ...extra,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "greatcms-update-"));
  asked = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the update notice", () => {
  it("compares releases by number, not by spelling", () => {
    expect(isNewer("0.1.10", "0.1.9")).toBe(true);
    expect(isNewer("0.2.0", "0.1.30")).toBe(true);
    expect(isNewer("0.1.3", "0.1.3")).toBe(false);
    expect(isNewer("0.1.2", "0.1.3")).toBe(false);
    expect(isNewer("1.0.0-beta.1", "0.1.3")).toBe(false);
    expect(isNewer("latest", "0.1.3")).toBe(false);
  });

  it("names the newer release and the command for this project's package manager", async () => {
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    expect(await check()).toBe(
      "\ngreatcms 0.2.0 is available: this is 0.1.3.\n  update: pnpm add -D @greatcms/cli@latest @greatcms/reader@latest\n",
    );
    expect(updateCommand(tmpdir())).toMatch(/^npm install -D /);
  });

  it("asks npm once a day, and again after that", async () => {
    const now = Date.now();
    await check({ now });
    expect(await check({ now: now + 23 * 60 * 60_000 })).toContain("0.2.0");
    expect(asked).toBe(1);
    await check({ now: now + 25 * 60 * 60_000 });
    expect(asked).toBe(2);
  });

  it("says nothing when this is the latest, or newer than npm has", async () => {
    expect(await check({ fetcher: answers("0.1.3") })).toBeNull();
    expect(await check({ current: "0.3.0", cacheFile: join(dir, "other.json") })).toBeNull();
  });

  it("says nothing to a script, in CI, or when switched off, and asks nobody", async () => {
    expect(await check({ interactive: false })).toBeNull();
    expect(await check({ env: { CI: "true" } })).toBeNull();
    expect(await check({ env: { GREATCMS_NO_UPDATE_CHECK: "1" } })).toBeNull();
    expect(await check({ env: { NO_UPDATE_NOTIFIER: "1" } })).toBeNull();
    expect(asked).toBe(0);
  });

  it("stays quiet, and does not ask again today, when npm fails or answers nonsense", async () => {
    const failing: typeof fetch = async () => {
      asked++;
      throw new Error("offline");
    };
    expect(await check({ fetcher: failing })).toBeNull();
    expect(await check({ fetcher: failing })).toBeNull();
    expect(asked).toBe(1);
    for (const [index, version] of ["<b>1.0.0</b>", 7, "9.9.9\n  update: rm -rf /"].entries()) {
      // oxlint-disable-next-line no-await-in-loop -- three answers, one after the other
      const said = await check({
        fetcher: answers(version),
        cacheFile: join(dir, `${index}.json`),
      });
      expect(said).toBeNull();
    }
    expect(
      await check({ fetcher: answers("9.9.9", 500), cacheFile: join(dir, "x.json") }),
    ).toBeNull();
  });

  it("believes nothing odd it finds in its own cache", async () => {
    const cacheFile = join(dir, "update.json");
    writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), latest: "9.9.9; rm -rf /" }));
    expect(await check({ cacheFile })).toBeNull();
    writeFileSync(cacheFile, "not json");
    expect(await check({ cacheFile })).toContain("0.2.0");
    expect(JSON.parse(readFileSync(cacheFile, "utf8")).latest).toBe("0.2.0");
  });
});
