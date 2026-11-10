/** Drives the CLI against a real repository on disk: real git, real files, real draft branch. */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSchema } from "@greatcms/spec";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseFlags, run } from "./index.js";

let repo: string;
const out: string[] = [];
const err: string[] = [];

const git = (args: string[], cwd = repo) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function cli(argv: string[]) {
  out.length = 0;
  err.length = 0;
  return run({
    argv,
    cwd: repo,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "greatcms-cli-"));

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);

  mkdirSync(join(repo, ".cms"), { recursive: true });
  mkdirSync(join(repo, "content/cms"), { recursive: true });

  writeFileSync(
    join(repo, ".cms/schema.yaml"),
    `version: 1
regions:
  home.hero:
    fields:
      heading: { type: text, required: true, default: Live heading }
  about.intro:
    fields:
      heading: { type: text, default: About us }
`,
  );
  writeFileSync(join(repo, ".cms/config.yaml"), "version: 1\n");
  writeFileSync(join(repo, "content/cms/home.hero.json"), '{\n  "heading": "Live heading"\n}\n');

  git(["add", "-A"]);
  git(["commit", "-qm", "initial"]);

  // A draft branch, exactly as the studio would push one.
  git(["checkout", "-q", "-b", "cms/draft-home.hero"]);
  writeFileSync(join(repo, "content/cms/home.hero.json"), '{\n  "heading": "Draft heading"\n}\n');
  git(["add", "-A"]);
  git(["commit", "-qm", "content(draft): home.hero"]);
  git(["checkout", "-q", "main"]);

  // The repository is its own remote, which is all `ls-remote` and `fetch` need.
  git(["remote", "add", "origin", repo]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("greatcms doctor", () => {
  it("reports which regions have content and which fall back to defaults", async () => {
    expect(await cli(["doctor"])).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/edited\s+home\.hero/);
    expect(text).toMatch(/default\s+about\.intro/);
    expect(text).toContain("will render schema defaults. That is normal, not a problem.");
  });
});

describe("command help", () => {
  it.each(["init", "add", "check", "types", "doctor"])(
    "shows help for greatcms %s --help without touching the repository",
    async (command) => {
      const before = git(["status", "--short"]);

      expect(await cli([command, "--help"])).toBe(0);
      expect(out.join("")).toContain(`Usage: greatcms ${command}`);
      expect(err).toEqual([]);
      expect(git(["status", "--short"])).toBe(before);
    },
  );
});

describe("reading flags", () => {
  it("never lets a switch swallow the argument after it", () => {
    const flags = parseFlags(["region", "--yes", "hero.banner"]);

    expect(flags.boolean("yes")).toBe(true);
    expect(flags.positionals).toEqual(["region", "hero.banner"]);
  });

  it("takes --name=value as well as --name value", () => {
    expect(parseFlags(["--out=src/cms.d.ts"]).string("out")).toBe("src/cms.d.ts");
    expect(parseFlags(["--out", "src/cms.d.ts"]).string("out")).toBe("src/cms.d.ts");
    expect(parseFlags(["--field=a:text", "--field", "b:image"]).strings("field")).toEqual([
      "a:text",
      "b:image",
    ]);
  });

  it("reads short flags, alone, together, and with a value", () => {
    const flags = parseFlags(["-yf", "-o", "out.d.ts", "name"]);
    expect([flags.boolean("yes"), flags.boolean("force"), flags.string("out")]).toEqual([
      true,
      true,
      "out.d.ts",
    ]);
    expect(flags.positionals).toEqual(["name"]);
    expect(parseFlags(["-oout.d.ts"]).string("out")).toBe("out.d.ts");
  });

  it("stops reading options at --", () => {
    expect(parseFlags(["--", "--yes"]).positionals).toEqual(["--yes"]);
  });

  it("reports a misspelt flag instead of silently ignoring it, and suggests the real one", async () => {
    expect(await cli(["check", "--jsno"])).toBe(2);
    expect(err.join("")).toContain("Unknown option --jsno");
    expect(err.join("")).toContain("Did you mean --json?");
  });
});

describe("greatcms types --check", () => {
  it("fails without --out, because a check with nothing to compare can never fail", async () => {
    expect(await cli(["types", "--check"])).toBe(1);
    expect(err.join("")).toContain("--out");
    expect(out.join("")).toBe("");
  });
});

describe("greatcms doctor and fonts from another site", () => {
  it("says nothing when the site serves its own fonts", async () => {
    expect(await cli(["doctor"])).toBe(0);
    expect(out.join("")).not.toContain("Fonts are fetched");
    out.length = 0;
    expect(await cli(["doctor", "--json"])).toBe(0);
    expect(JSON.parse(out.join("")).remoteFonts).toEqual([]);
  });

  it("names the files that pull fonts in at page load, and how to stop, without failing", async () => {
    mkdirSync(join(repo, "src/styles"), { recursive: true });
    mkdirSync(join(repo, "node_modules/some-theme"), { recursive: true });
    mkdirSync(join(repo, "dist"), { recursive: true });
    const remote = "@import url('https://fonts.googleapis.com/css2?family=Archivo&display=swap');";
    writeFileSync(join(repo, "src/styles/global.css"), `${remote}\nbody { margin: 0; }\n`);
    writeFileSync(
      join(repo, "src/Layout.astro"),
      '<link rel="preconnect" href="https://fonts.gstatic.com" />',
    );
    writeFileSync(
      join(repo, "src/styles/local.css"),
      "@font-face { font-family: Mine; src: url(/mine.woff2); }",
    );
    // Someone else's code and the built site are not the site's source.
    writeFileSync(join(repo, "node_modules/some-theme/theme.css"), remote);
    writeFileSync(join(repo, "dist/index.html"), remote);
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ dependencies: { astro: "^7.0.0" } }),
    );
    try {
      expect(await cli(["doctor"])).toBe(0);
      const text = out.join("");
      expect(text).toContain("Fonts are fetched from another site while the page loads");
      expect(text).toMatch(/src\/Layout\.astro\s+src\/styles\/global\.css\s/);
      expect(text).not.toContain("local.css");
      expect(text).not.toContain("some-theme");
      expect(text).not.toContain("dist/index.html");
      expect(text).toContain("run `greatcms fonts`");
      out.length = 0;
      expect(await cli(["doctor", "--json"])).toBe(0);
      expect(JSON.parse(out.join("")).remoteFonts).toEqual([
        "src/Layout.astro",
        "src/styles/global.css",
      ]);

      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ dependencies: { next: "^16.0.0" } }),
      );
      out.length = 0;
      expect(await cli(["doctor"])).toBe(0);
      expect(out.join("")).toContain("serve the font files from the site");
      expect(out.join("")).not.toContain("greatcms fonts");
    } finally {
      for (const path of ["src", "node_modules", "dist", "package.json"]) {
        rmSync(join(repo, path), { recursive: true, force: true });
      }
    }
  });
});

describe("greatcms doctor and unsaved drafts", () => {
  it("says nothing about drafts when there are none", async () => {
    expect(await cli(["doctor"])).toBe(0);
    expect(out.join("")).not.toContain("unsaved edit");
  });

  it("names a forgotten draft, which only ever shows in dev", async () => {
    mkdirSync(join(repo, ".cms/draft/content/cms"), { recursive: true });
    writeFileSync(join(repo, ".cms/draft/content/cms/home.hero.json"), '{"heading":"Forgotten"}');
    try {
      expect(await cli(["doctor"])).toBe(0);
      const text = out.join("");
      expect(text).toContain("1 unsaved edit");
      expect(text).toContain("content/cms/home.hero.json");
      expect(text).toContain("fix:");
    } finally {
      rmSync(join(repo, ".cms/draft"), { recursive: true, force: true });
    }
  });
});

describe("greatcms check", () => {
  it("passes on the repository as committed", async () => {
    expect(await cli(["check"])).toBe(0);
    expect(out.join("")).toContain("content: OK");
  });

  it("fails, on stderr, when a content file no longer fits the schema", async () => {
    writeFileSync(join(repo, "content/cms/home.hero.json"), '{"heading":""}');
    try {
      expect(await cli(["check"])).toBe(1);
      expect(err.join("")).toContain("content/cms/home.hero.json");
      expect(err.join("")).toContain("required");
    } finally {
      git(["checkout", "--", "content/cms/home.hero.json"]);
    }
  });

  it("passes with a warning, on stdout, when an upload is unused", async () => {
    mkdirSync(join(repo, "public/media"), { recursive: true });
    writeFileSync(join(repo, "public/media/stray.png"), "bytes");
    try {
      expect(await cli(["check"])).toBe(0);
      expect(out.join("")).toContain("public/media/stray.png");
      expect(out.join("")).toContain("content: OK, 1 warning");
      expect(err.join("")).toBe("");

      expect(await cli(["check", "--json"])).toBe(0);
      const report = JSON.parse(out.join("")) as { ok: boolean; warnings: { code: string }[] };
      expect(report.ok).toBe(true);
      expect(report.warnings.map((warning) => warning.code)).toEqual(["unused_media"]);
    } finally {
      rmSync(join(repo, "public"), { recursive: true, force: true });
    }
  });

  it("reports as JSON for CI and for agents", async () => {
    expect(await cli(["check", "--json"])).toBe(0);
    const report = JSON.parse(out.join("")) as { ok: boolean; checked: { regions: number } };
    expect(report.ok).toBe(true);
    expect(report.checked.regions).toBe(1);
  });
});

describe("unknown input", () => {
  it("points at the help rather than printing a stack trace", async () => {
    expect(await cli(["wat"])).toBe(2);
    expect(err.join("")).toContain("greatcms --help");
  });

  it("does not leave a stray overlay behind after all of that", () => {
    expect(existsSync(join(repo, "content/cms/about.intro.json"))).toBe(false);
  });
});

describe("greatcms init", () => {
  let fresh: string;

  const initIn = (dir: string, argv: string[]) => {
    out.length = 0;
    err.length = 0;
    return run({
      argv,
      cwd: dir,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    });
  };

  beforeEach(() => {
    fresh = mkdtempSync(join(tmpdir(), "greatcms-init-"));
  });

  afterEach(() => {
    rmSync(fresh, { recursive: true, force: true });
  });

  it("scaffolds a working setup with no questions asked", async () => {
    writeFileSync(join(fresh, "astro.config.mjs"), "export default {};\n");

    expect(await initIn(fresh, ["init", "--yes"])).toBe(0);

    const schema = readFileSync(join(fresh, ".cms/schema.yaml"), "utf8");
    const config = readFileSync(join(fresh, ".cms/config.yaml"), "utf8");

    expect(schema).toContain("yaml-language-server");
    // Astro was detected, so content lands where Astro already looks.
    expect(config).toContain("regions: src/content/cms");
    expect(out.join("")).toContain("Detected Astro");
  });

  it("leaves a note for the next agent, and updates it rather than repeating it", async () => {
    writeFileSync(join(fresh, "astro.config.mjs"), "export default {};\n");
    writeFileSync(join(fresh, "AGENTS.md"), "# Our rules\n\nRun the tests.\n");

    await initIn(fresh, ["init", "--yes"]);
    await initIn(fresh, ["init", "--yes", "--force"]);

    const agents = readFileSync(join(fresh, "AGENTS.md"), "utf8");
    expect(agents.startsWith("# Our rules\n\nRun the tests.\n")).toBe(true);
    expect(agents.match(/greatcms:start/g)).toHaveLength(1);
    expect(agents).toContain("src/content/cms/<region-id>.json");
    expect(agents).toContain("greatcms check --json");
  });

  it("tells you how to read the region in the framework it found", async () => {
    writeFileSync(join(fresh, "next.config.mjs"), "export default {};\n");

    await initIn(fresh, ["init", "--yes"]);

    const text = out.join("");
    expect(text).toContain("Detected Next.js");
    expect(text).toContain("a server component");
    expect(readFileSync(join(fresh, ".cms/config.yaml"), "utf8")).toContain("regions: content/cms");
  });

  it("honours explicit flags over detection", async () => {
    writeFileSync(join(fresh, "astro.config.mjs"), "export default {};\n");

    await initIn(fresh, [
      "init",
      "--yes",
      "--framework",
      "nuxt",
      "--template",
      "landing",
      "--name",
      "Flagged Site",
      "--dir",
      "_data/managed",
    ]);

    const schema = readFileSync(join(fresh, ".cms/schema.yaml"), "utf8");
    expect(schema).toContain("Flagged Site");
    expect(schema).toContain("type: blocks");
    expect(readFileSync(join(fresh, ".cms/config.yaml"), "utf8")).toContain(
      "regions: _data/managed",
    );
    expect(out.join("")).toContain("Using Nuxt (--framework)");
    expect(out.join("")).not.toContain("Detected Astro");
  });

  it("refuses to clobber an existing setup, and says how to proceed", async () => {
    await initIn(fresh, ["init", "--yes"]);
    const original = readFileSync(join(fresh, ".cms/schema.yaml"), "utf8");

    expect(await initIn(fresh, ["init", "--yes", "--name", "Overwritten"])).toBe(1);
    expect(err.join("")).toContain("already set up");
    expect(err.join("")).toContain("--force");
    expect(readFileSync(join(fresh, ".cms/schema.yaml"), "utf8")).toBe(original);

    expect(await initIn(fresh, ["init", "--yes", "--force", "--name", "Overwritten"])).toBe(0);
    expect(readFileSync(join(fresh, ".cms/schema.yaml"), "utf8")).toContain("Overwritten");
  });

  it("rejects an unknown framework by name, listing the real ones", async () => {
    expect(await initIn(fresh, ["init", "--yes", "--framework", "wordpress"])).toBe(2);
    expect(err.join("")).toContain("astro");
  });

  it("leaves a repository ready for doctor to confirm", async () => {
    writeFileSync(join(fresh, "astro.config.mjs"), "export default {};\n");
    await initIn(fresh, ["init", "--yes", "--template", "blog"]);

    expect(await initIn(fresh, ["doctor"])).toBe(0);
    const text = out.join("");
    expect(text).toContain("home.hero");
    expect(text).toContain("Collections (1)");
    expect(text).toContain("  blog");
  });

  it("adds a reusable section to the sole page region in one command", async () => {
    await initIn(fresh, ["init", "--yes", "--template", "business"]);

    expect(
      await initIn(fresh, [
        "add",
        "section",
        "testimonial",
        "--field",
        "quote:richtext!",
        "--field",
        "name:text!",
      ]),
    ).toBe(0);

    const schema = parseSchema(readFileSync(join(fresh, ".cms/schema.yaml"), "utf8"));
    expect(schema.blocks.testimonial).toBeTruthy();
    expect(schema.regions["home.sections"]).toMatchObject({
      allow: [
        "feature-grid",
        "process",
        "stats",
        "story",
        "products",
        "faq-list",
        "cta",
        "testimonial",
      ],
    });
    expect(out.join("")).toContain("Editors can now add it in home.sections");
    expect(out.join("")).toContain('_type: "testimonial"');
  });

  it("makes a region a list of the blocks named with --blocks", async () => {
    await initIn(fresh, ["init", "--yes", "--template", "blank"]);
    expect(await initIn(fresh, ["add", "block", "card", "--field", "title:text!"])).toBe(0);

    expect(await initIn(fresh, ["add", "region", "home.cards", "--blocks", "card"])).toBe(0);
    const schema = parseSchema(readFileSync(join(fresh, ".cms/schema.yaml"), "utf8"));
    expect(schema.regions["home.cards"]).toMatchObject({ allow: ["card"] });
  });
});
