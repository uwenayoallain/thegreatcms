import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { greatcmsWatch } from "./vite.js";

let root: string;

/** Just enough of a Vite dev server for the plugin to talk to. */
function fakeServer() {
  const watched: string[] = [];
  const handlers: Record<string, Array<(path: string) => void>> = {};
  const restart = vi.fn();

  return {
    watched,
    restart,
    fire(event: "add" | "change" | "unlink", path: string) {
      for (const handler of handlers[event] ?? []) handler(path);
    },
    server: {
      watcher: {
        add: (paths: string | string[]) => {
          watched.push(...(Array.isArray(paths) ? paths : [paths]));
        },
        on: (event: string, handler: (path: string) => void) => {
          (handlers[event] ??= []).push(handler);
        },
      },
      restart,
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "greatcms-vite-"));
  mkdirSync(join(root, ".cms"), { recursive: true });
  writeFileSync(
    join(root, ".cms/config.yaml"),
    "version: 1\ncontent:\n  regions: data/cms\n  media: static/media\n",
  );
  writeFileSync(
    join(root, ".cms/schema.yaml"),
    `version: 1
regions:
  home.hero:
    fields:
      heading: { type: text }
collections:
  blog:
    path: content/articles
    fields:
      title: { type: text }
`,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the dev-time content watcher", () => {
  it("only runs in dev, because a build reads from disk anyway", () => {
    expect(greatcmsWatch({ root }).apply).toBe("serve");
  });

  it("watches the directories this site's own config declares", () => {
    const { server, watched } = fakeServer();
    greatcmsWatch({ root }).configureServer(server);

    expect(watched).toContain(join(root, "data/cms"));
    expect(watched).toContain(join(root, "static/media"));
    // Collections live wherever the schema says, often outside content/.
    expect(watched).toContain(join(root, "content/articles"));
  });

  it("reloads when a content file changes", async () => {
    const { server, fire, restart } = fakeServer();
    greatcmsWatch({ root }).configureServer(server);

    fire("change", join(root, "data/cms/home.hero.json"));
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
  });

  it("reloads when one is created or deleted, not only edited", async () => {
    const { server, fire, restart } = fakeServer();
    greatcmsWatch({ root }).configureServer(server);

    fire("add", join(root, "data/cms/new.json"));
    await vi.waitFor(() => expect(restart).toHaveBeenCalled());

    restart.mockClear();
    fire("unlink", join(root, "data/cms/new.json"));
    await vi.waitFor(() => expect(restart).toHaveBeenCalled());
  });

  it("restarts once for a publish that writes several files", async () => {
    const { server, fire, restart } = fakeServer();
    greatcmsWatch({ root }).configureServer(server);

    fire("change", join(root, "data/cms/home.hero.json"));
    fire("change", join(root, "static/media/a.png"));
    fire("change", join(root, "data/cms/home.body.json"));

    await vi.waitFor(() => expect(restart).toHaveBeenCalled());
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("ignores changes to source files, which Vite already handles", async () => {
    const { server, fire, restart } = fakeServer();
    greatcmsWatch({ root }).configureServer(server);

    fire("change", join(root, "src/pages/index.astro"));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(restart).not.toHaveBeenCalled();
  });

  it("starts a dev server even with no .cms directory at all", () => {
    const bare = mkdtempSync(join(tmpdir(), "greatcms-bare-"));
    const { server, watched } = fakeServer();

    expect(() => greatcmsWatch({ root: bare }).configureServer(server)).not.toThrow();
    expect(watched).toContain(join(bare, "content/cms"));

    rmSync(bare, { recursive: true, force: true });
  });
});
