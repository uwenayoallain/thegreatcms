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
  const send = vi.fn();

  return {
    watched,
    restart,
    send,
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
      hot: { send },
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

  it("watches the drafts the studio writes while you are still typing", () => {
    const { server, watched } = fakeServer();
    greatcmsWatch({ root }).configureServer(server);

    expect(watched.some((path) => path.startsWith(join(root, ".cms/draft")))).toBe(true);
  });

  it("reloads the page when a content file changes, without restarting", async () => {
    const { server, fire, send, restart } = fakeServer();
    greatcmsWatch({ root }).configureServer(server);

    fire("change", join(root, "data/cms/home.hero.json"));
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: "full-reload", path: "*" }));
    expect(restart).not.toHaveBeenCalled();
  });

  it("reloads for an unsaved draft, which is the live editing loop", async () => {
    const { server, fire, send } = fakeServer();
    greatcmsWatch({ root }).configureServer(server);

    fire("add", join(root, ".cms/draft/data/cms/home.hero.json"));
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
  });

  it("reloads when a file is created or deleted, not only edited", async () => {
    const { server, fire, send } = fakeServer();
    greatcmsWatch({ root }).configureServer(server);

    fire("add", join(root, "data/cms/new.json"));
    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    send.mockClear();
    fire("unlink", join(root, "data/cms/new.json"));
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
  });

  it("reloads once for a publish that writes several files", async () => {
    const { server, fire, send } = fakeServer();
    greatcmsWatch({ root }).configureServer(server);

    fire("change", join(root, "data/cms/home.hero.json"));
    fire("change", join(root, "static/media/a.png"));
    fire("change", join(root, "data/cms/home.body.json"));

    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("falls back to a restart when the server exposes no socket", async () => {
    const { server, fire, restart } = fakeServer();
    const withoutSocket = { ...server, hot: undefined };
    greatcmsWatch({ root }).configureServer(withoutSocket);

    fire("change", join(root, "data/cms/home.hero.json"));
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
  });

  it("ignores changes to source files, which Vite already handles", async () => {
    const { server, fire, send } = fakeServer();
    greatcmsWatch({ root }).configureServer(server);

    fire("change", join(root, "src/pages/index.astro"));
    await new Promise((resolve) => setTimeout(resolve, 140));
    expect(send).not.toHaveBeenCalled();
  });

  it("starts a dev server even with no .cms directory at all", () => {
    const bare = mkdtempSync(join(tmpdir(), "greatcms-bare-"));
    const { server, watched } = fakeServer();

    expect(() => greatcmsWatch({ root: bare }).configureServer(server)).not.toThrow();
    expect(watched).toContain(join(bare, "content/cms"));

    rmSync(bare, { recursive: true, force: true });
  });
});
