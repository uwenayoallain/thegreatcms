/**
 * Times the hot routes in-process against the Paraline example grown to 300 entries.
 * Run: pnpm --filter @greatcms/studio exec vitest bench --run bench/routes.bench.ts
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterAll, bench, describe } from "vitest";
import { createApp } from "../src/app.js";
import { createSessionCookie, sessionKey } from "../src/auth.js";
import { Store } from "../src/db.js";

const example = fileURLToPath(new URL("../../../examples/studio-astro", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "greatcms-bench-"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });

for (const folder of [".cms", "content", "public/media"]) {
  cpSync(join(example, folder), join(root, folder), { recursive: true });
}
const work = join(root, "content/work");
const seeds = readdirSync(work).map((file) => readFileSync(join(work, file), "utf8"));
for (let index = 0; index < 300; index++) {
  const entry = JSON.parse(seeds[index % seeds.length] as string) as Record<string, unknown>;
  entry.title = `${String(entry.title)} ${index}`;
  writeFileSync(join(work, `project-${index}.json`), `${JSON.stringify(entry, null, 2)}\n`);
}
git("init", "-q", "-b", "main");
git("config", "user.email", "bench@example.com");
git("config", "user.name", "Bench");
git("add", "-A");
git("commit", "-qm", "initial");
for (let index = 0; index < 60; index++) {
  const file = join(work, `project-${index}.json`);
  writeFileSync(file, readFileSync(file, "utf8").replace(/\n$/, " \n"));
  git("commit", "-qam", `content: update work/project-${index}`);
}

const store = new Store(":memory:");
store.addSite({ id: "bench", name: "Paraline", path: root, devUrl: "", createdAt: "2026-01-01" });
store.addSite({ id: "other", name: "Other", path: root, devUrl: "", createdAt: "2026-01-01" });
const app = createApp({ store, password: "bench-password", secret: "bench-secret" });
const cookie = createSessionCookie(sessionKey("bench-secret", "bench-password")).split(
  ";",
)[0] as string;
const headers = { cookie, "accept-encoding": "br, gzip" };

const get = async (path: string) => {
  const response = await app.request(path, { headers });
  if (response.status !== 200) throw new Error(`${path} answered ${response.status}`);
  await response.arrayBuffer();
};

const hero = await (
  await app.request("/sites/bench/regions/home.hero", { headers: { cookie } })
).text();
const form = new JSDOM(hero).window.document.querySelector("#editor-form") as HTMLFormElement;
const fields = new URLSearchParams();
for (const control of form.querySelectorAll<HTMLInputElement>("input[name], textarea[name]")) {
  if (control.type !== "file" && control.type !== "submit" && control.name !== "headSha") {
    fields.append(control.name, control.value);
  }
}
let round = 0;

afterAll(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const options = { time: 1500, warmupTime: 300 };

describe("routes", () => {
  bench("sites list", () => get("/"), options);
  bench("site page", () => get("/sites/bench"), options);
  bench("region editor", () => get("/sites/bench/regions/home.hero"), options);
  bench("blocks region editor", () => get("/sites/bench/regions/home.sections"), options);
  bench("collection list (305 entries)", () => get("/sites/bench/collections/work"), options);
  bench("entry editor", () => get("/sites/bench/collections/work/project-7"), options);
  bench("search", () => get("/sites/bench/search?q=studio"), options);
  bench("history", () => get("/sites/bench/regions/home.hero/history"), options);
  bench("stylesheet", () => get("/assets/studio.css"), options);
  bench(
    "publish a region",
    async () => {
      const body = new URLSearchParams(fields);
      body.set("eyebrow", `Round ${round++}`);
      body.set("action", "publish");
      const response = await app.request("/sites/bench/regions/home.hero", {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (response.status !== 200) {
        throw new Error(
          `publish answered ${response.status}: ${(await response.text()).slice(0, 2000)}`,
        );
      }
      await response.arrayBuffer();
    },
    options,
  );
});
