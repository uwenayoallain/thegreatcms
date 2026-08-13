import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfig } from "@greatcms/spec";
import {
  applyOverlay,
  assertContentIsClean,
  findDraftBranches,
  planPreview,
  PreviewError,
  type FilePort,
  type GitPort,
} from "./preview.js";

/** A git that answers from a script, and records what it was asked. */
function fakeGit(responses: Record<string, string>) {
  const calls: string[][] = [];
  const git: GitPort = {
    async run(args) {
      calls.push(args);
      const key = args.join(" ");
      for (const [pattern, value] of Object.entries(responses)) {
        if (key.startsWith(pattern)) return value;
      }
      return "";
    },
  };
  return { git, calls };
}

function fakeFiles(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const files: FilePort = {
    async read(path) {
      return store.get(path) ?? null;
    },
    async write(path, content) {
      store.set(path, content);
    },
    async remove(path) {
      store.delete(path);
    },
  };
  return { files, store };
}

const config = DEFAULT_CONFIG;

describe("finding drafts", () => {
  it("lists draft branches on the remote", async () => {
    const { git } = fakeGit({
      "ls-remote": "sha1\trefs/heads/cms/draft-home.hero\nsha2\trefs/heads/cms/draft-about.intro\n",
    });
    expect(await findDraftBranches(git, config)).toEqual([
      "cms/draft-about.intro",
      "cms/draft-home.hero",
    ]);
  });

  it("says what to do when there are none", async () => {
    const { git } = fakeGit({ "ls-remote": "" });
    const { files } = fakeFiles();
    await expect(planPreview(git, files, { config })).rejects.toThrow(/Save a draft in the studio/);
  });
});

describe("planning an overlay", () => {
  it("collects the content files a draft changes", async () => {
    const { git } = fakeGit({
      "ls-remote": "sha\trefs/heads/cms/draft-home.hero\n",
      diff: "content/cms/home.hero.json\n",
      show: '{"heading":"Draft heading"}\n',
    });
    const { files } = fakeFiles({ "content/cms/home.hero.json": '{"heading":"Live"}\n' });

    const plan = await planPreview(git, files, { config });

    expect(plan.branches).toEqual(["cms/draft-home.hero"]);
    expect(plan.files).toEqual([
      {
        path: "content/cms/home.hero.json",
        previous: '{"heading":"Live"}\n',
        next: '{"heading":"Draft heading"}\n',
      },
    ]);
  });

  it("marks a file that does not exist yet as new", async () => {
    const { git } = fakeGit({
      "ls-remote": "sha\trefs/heads/cms/draft-about.intro\n",
      diff: "content/cms/about.intro.json\n",
      show: '{"heading":"First edit"}\n',
    });
    const { files } = fakeFiles();
    const plan = await planPreview(git, files, { config });
    expect(plan.files[0]?.previous).toBeNull();
  });

  it("refuses a draft branch that touches anything outside the content directories", async () => {
    const { git } = fakeGit({
      "ls-remote": "sha\trefs/heads/cms/draft-evil\n",
      diff: "content/cms/home.hero.json\nsrc/pages/index.astro\n",
      show: "{}",
    });
    const { files } = fakeFiles();

    await expect(planPreview(git, files, { config })).rejects.toThrow(
      /changes src\/pages\/index\.astro, which is outside the content directories/,
    );
  });

  it("allows media alongside content, since uploads travel with a draft", async () => {
    const { git } = fakeGit({
      "ls-remote": "sha\trefs/heads/cms/draft-home.hero\n",
      diff: "public/media/hero.webp\n",
      show: "binary-ish",
    });
    const { files } = fakeFiles();
    const plan = await planPreview(git, files, { config });
    expect(plan.files[0]?.path).toBe("public/media/hero.webp");
  });

  it("honours a custom content directory from the config", async () => {
    const custom = parseConfig("version: 1\ncontent:\n  regions: data/cms\n");
    const { git } = fakeGit({
      "ls-remote": "sha\trefs/heads/cms/draft-home.hero\n",
      diff: "data/cms/home.hero.json\n",
      show: "{}",
    });
    const { files } = fakeFiles();
    const plan = await planPreview(git, files, { config: custom });
    expect(plan.files[0]?.path).toBe("data/cms/home.hero.json");
  });

  it("previews a single named branch without listing the remote", async () => {
    const { git, calls } = fakeGit({ diff: "content/cms/home.hero.json\n", show: "{}" });
    const { files } = fakeFiles();
    await planPreview(git, files, { config, branch: "cms/draft-home.hero" });
    expect(calls.some((args) => args[0] === "ls-remote")).toBe(false);
  });
});

describe("applying and restoring", () => {
  it("writes drafts in, then puts the working copy back exactly", async () => {
    const { files, store } = fakeFiles({ "content/cms/home.hero.json": "LIVE" });
    const restore = await applyOverlay(files, {
      branches: ["cms/draft-home.hero"],
      files: [{ path: "content/cms/home.hero.json", previous: "LIVE", next: "DRAFT" }],
    });

    expect(store.get("content/cms/home.hero.json")).toBe("DRAFT");
    await restore();
    expect(store.get("content/cms/home.hero.json")).toBe("LIVE");
  });

  it("deletes files that did not exist before, rather than leaving them behind", async () => {
    const { files, store } = fakeFiles();
    const restore = await applyOverlay(files, {
      branches: ["cms/draft-new"],
      files: [{ path: "content/cms/new.json", previous: null, next: "DRAFT" }],
    });
    expect(store.has("content/cms/new.json")).toBe(true);
    await restore();
    expect(store.has("content/cms/new.json")).toBe(false);
  });
});

describe("protecting uncommitted work", () => {
  it("refuses to overlay on top of uncommitted content changes", async () => {
    const { git } = fakeGit({ status: " M content/cms/home.hero.json\n" });
    await expect(assertContentIsClean(git, config)).rejects.toThrow(PreviewError);
    await expect(assertContentIsClean(git, config)).rejects.toThrow(/Commit or stash them first/);
  });

  it("proceeds when only code has changed", async () => {
    const { git } = fakeGit({ status: "" });
    await expect(assertContentIsClean(git, config)).resolves.toBeUndefined();
  });

  it("can be overridden deliberately", async () => {
    const { git } = fakeGit({ status: " M content/cms/home.hero.json\n" });
    await expect(assertContentIsClean(git, config, true)).resolves.toBeUndefined();
  });
});
