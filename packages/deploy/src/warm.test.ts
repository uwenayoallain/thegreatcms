/** Walking a dev server's pages and modules before anyone sees them. */

import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { localFetch, warmModules } from "./warm.js";

type Answer = { type: string; body: string; status?: number };

/** A dev server as a table of paths; `outdated` paths answer 504 until asked that many times. */
function server(pages: Record<string, Answer>, outdated: Record<string, number> = {}) {
  const asked: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const path = String(input).replace("http://dev", "");
    asked.push(path);
    if ((outdated[path] ?? 0) > 0) {
      outdated[path]!--;
      return new Response("", { status: 504 });
    }
    const page = pages[path];
    if (!page) return new Response("", { status: 404 });
    return new Response(page.body, {
      status: page.status ?? 200,
      headers: { "content-type": page.type },
    });
  };
  return { asked, fetcher };
}

const html = (body: string): Answer => ({ type: "text/html", body });
const js = (body: string): Answer => ({ type: "text/javascript", body });
const quick = { pause: async () => {} };
const slow: typeof fetch = () => new Promise(() => {});
const failing: typeof fetch = async () => {
  throw new Error("refused");
};

describe("warming a dev server", () => {
  it("follows a page's scripts, their imports, and the pages it links to", async () => {
    const { asked, fetcher } = server({
      "/": html(
        `<a href="/about">About</a><script type="module" src="/src/app.ts"></script>
         <astro-island component-url="/src/Hero.tsx" renderer-url="/@id/react.js?v=1&amp;x=2"></astro-island>`,
      ),
      "/about": html(`<script type="module" src="/src/about.ts"></script>`),
      "/src/app.ts": js(
        `import { a } from "/node_modules/.vite/deps/a.js?v=1"; import("/src/lazy.ts");`,
      ),
      "/src/Hero.tsx": js(`import "/src/hero.css";`),
      "/src/about.ts": js(``),
      "/src/lazy.ts": js(``),
      "/@id/react.js?v=1&x=2": js(``),
      "/node_modules/.vite/deps/a.js?v=1": js(``),
      "/src/hero.css": js(``),
    });
    const warmed = await warmModules("http://dev", { fetcher, ...quick });
    expect(warmed).toEqual({ modules: 7, pages: 2, rounds: 1, settled: true });
    expect(new Set(asked).size).toBe(asked.length);
    expect(asked).toContain("/@id/react.js?v=1&x=2");
  });

  it("starts over while the dev server is still preparing dependencies, until it settles", async () => {
    const { asked, fetcher } = server(
      {
        "/": html(`<script type="module" src="/src/app.ts"></script>`),
        "/src/app.ts": js(`import "/node_modules/.vite/deps/react.js?v=1";`),
        "/node_modules/.vite/deps/react.js?v=1": js(``),
      },
      { "/node_modules/.vite/deps/react.js?v=1": 2 },
    );
    const warmed = await warmModules("http://dev", { fetcher, ...quick });
    expect(warmed.rounds).toBe(3);
    expect(warmed.settled).toBe(true);
    expect(asked.filter((path) => path === "/")).toHaveLength(3);
  });

  it("gives up after its rounds and says it has not settled", async () => {
    const { fetcher } = server(
      { "/": html(`<script type="module" src="/x.js"></script>`), "/x.js": js(``) },
      { "/x.js": 99 },
    );
    const warmed = await warmModules("http://dev", { fetcher, rounds: 2, ...quick });
    expect(warmed).toMatchObject({ rounds: 2, settled: false });
  });

  it("asks only this server, however a page spells another", async () => {
    const { asked, fetcher } = server({
      "/": html(
        `<script src="//evil.example/x.js"></script><script src="/\\evil.example/y.js"></script>
         <script src="https://cdn.example/z.js"></script><a href="//evil.example/">x</a>
         <script type="module" src="/ok.js"></script>`,
      ),
      "/ok.js": js(`import "//evil.example/a.js"; import "https://cdn.example/b.js";`),
    });
    await warmModules("http://dev", { fetcher, ...quick });
    expect(asked.toSorted()).toEqual(["/", "/ok.js"]);
  });

  it("stops at its limits: so many modules, so many pages, so much time", async () => {
    const many = Object.fromEntries(
      Array.from({ length: 50 }, (_, index) => [
        `/m${index}.js`,
        js(`import "/m${index + 1}.js";`),
      ]),
    );
    const links = Array.from({ length: 20 }, (_, index) => `<a href="/p${index}">p</a>`).join("");
    const pages = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`/p${index}`, html("")]),
    );
    const { asked, fetcher } = server({
      "/": html(`${links}<script type="module" src="/m0.js"></script>`),
      ...many,
      ...pages,
    });
    const warmed = await warmModules("http://dev", {
      fetcher,
      maxModules: 12,
      maxPages: 3,
      ...quick,
    });
    expect(asked.length).toBeLessThanOrEqual(12);
    expect(warmed.pages).toBe(4);

    const began = Date.now();
    const late = await warmModules("http://dev", { fetcher: slow, budgetMs: 200, ...quick });
    expect(Date.now() - began).toBeLessThan(3000);
    expect(late.settled).toBe(false);
  });

  it("reaches a dev dev on a port the built-in fetch refuses", async () => {
    const dev = createServer((req, res) => {
      if (req.url === "/app.js") {
        res.setHeader("content-type", "text/javascript");
        return res.end("");
      }
      if (req.url === "/gone") return res.writeHead(304).end();
      res.setHeader("content-type", "text/html");
      res.end(`<script type="module" src="/app.js"></script>`);
    });
    // 6000 is on the list of ports fetch will not connect to; any free one of them will do.
    const port = await new Promise<number>((resolve, reject) => {
      const tryPort = (candidates: number[]) => {
        const [next, ...rest] = candidates;
        if (next === undefined) return reject(new Error("no refused port is free"));
        dev.once("error", () => tryPort(rest));
        dev.listen(next, "127.0.0.1", () => resolve((dev.address() as AddressInfo).port));
      };
      tryPort([6000, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);
    });
    try {
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
      const warmed = await warmModules(`http://127.0.0.1:${port}`, quick);
      expect(warmed).toEqual({ modules: 1, pages: 1, rounds: 1, settled: true });
      expect((await localFetch(`http://127.0.0.1:${port}/gone`)).status).toBe(304);
    } finally {
      dev.close();
    }
  });

  it("survives a server that fails or answers nothing useful", async () => {
    expect(await warmModules("http://dev", { fetcher: failing, ...quick })).toMatchObject({
      modules: 0,
      settled: true,
    });
  });
});
