/** A site's own code can write `.git/config`; nothing it puts there is run by the studio's git. */

import { execFile, execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { originOf } from "../src/connect.js";
import {
  checkConfig,
  classify,
  findRepository,
  gitIn,
  parseGitConfig,
  trustFolderGitConfig,
} from "../src/git-guard.js";
import { LocalRepository } from "../src/repo.js";
import { get, makeSite, post, SITE_ID, type Fixture } from "./site.js";

const run = promisify(execFile);

const SCHEMA = `version: 1
regions:
  home.hero:
    fields:
      heading: { type: text, required: true }
`;

let site: Fixture;
let outside: string;
let remote: string;

/** A command that leaves a file behind if anything runs it, then does what git expects of it. */
const leaves = (name: string, then = "") => `touch '${join(outside, `ran-${name}`)}'; ${then}`;
const ran = () => readdirSync(outside).filter((name) => name.startsWith("ran-"));

const plant = (text: string) => appendFileSync(join(site.root, ".git/config"), `\n${text}\n`);

const hook = (folder: string, name: string) => {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, name), `#!/bin/sh\n${leaves(`hook-${name}`)}\n`);
  chmodSync(join(folder, name), 0o755);
};

/** The commit the folder is on, asked the studio's way: plain git may not read a planted config at all. */
const head = () => new LocalRepository(site.root).getHead();
const forget = () => {
  for (const name of ran()) rmSync(join(outside, name));
};

const publish = async (heading: string) =>
  post(site, `/sites/${SITE_ID}/regions/home.hero`, {
    headSha: await head(),
    action: "publish",
    "f[heading]": heading,
  });

beforeEach(() => {
  trustFolderGitConfig(false);
  outside = mkdtempSync(join(tmpdir(), "greatcms-outside-"));
  remote = join(outside, "remote.git");
  site = makeSite({
    schema: SCHEMA,
    files: {
      // Every file names drivers that only the folder's config could define.
      ".gitattributes": "* filter=planted diff=planted merge=planted\n",
      "content/cms/home.hero.json": '{"heading":"Before"}\n',
    },
  });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  site.git(["remote", "add", "origin", remote]);
  site.git(["push", "-q", "-u", "origin", "main"]);
  writeFileSync(join(site.root, ".git/info/attributes"), "* filter=planted diff=planted\n");
  for (const name of [
    "pre-commit",
    "commit-msg",
    "post-commit",
    "pre-push",
    "post-checkout",
    "reference-transaction",
    "post-index-change",
  ]) {
    hook(join(site.root, ".git/hooks"), name);
  }
});

afterEach(() => {
  site.cleanup();
  rmSync(outside, { recursive: true, force: true });
});

/** Each way the folder's config can name a program or send a push elsewhere. */
const PLANTED: Array<{ name: string; config: () => string; refused: string }> = [
  {
    name: "a file-watcher program",
    config: () => `[core]\n\tfsmonitor = "${leaves("fsmonitor", "false")}"`,
    refused: "",
  },
  {
    name: "a hooks folder",
    config: () => {
      for (const name of ["pre-commit", "post-commit", "pre-push", "post-checkout"]) {
        hook(join(outside, "hooks"), name);
      }
      return `[core]\n\thooksPath = ${join(outside, "hooks")}`;
    },
    refused: "",
  },
  {
    name: "an ssh command",
    config: () => `[core]\n\tsshCommand = "${leaves("ssh", "false")}"`,
    refused: "core.sshcommand",
  },
  {
    name: "a proxy command",
    config: () => `[core]\n\tgitProxy = "${leaves("gitproxy")}"`,
    refused: "core.gitproxy",
  },
  {
    name: "a pager",
    config: () => `[core]\n\tpager = "${leaves("pager", "cat")}"\n[pager]\n\tlog = true`,
    refused: "core.pager",
  },
  {
    name: "an editor",
    config: () =>
      `[core]\n\teditor = "${leaves("editor")}"\n[sequence]\n\teditor = "${leaves("sequence")}"`,
    refused: "core.editor",
  },
  {
    name: "a password prompt program",
    config: () => `[core]\n\taskPass = "${leaves("askpass")}"`,
    refused: "core.askpass",
  },
  {
    name: "a credential helper",
    config: () =>
      `[credential]\n\thelper = "!${leaves("credential")}"\n[credential "https://example.com"]\n\thelper = "!${leaves("credential-url")}"`,
    refused: "credential.helper",
  },
  {
    name: "a signing program",
    config: () =>
      `[gpg]\n\tprogram = "${leaves("gpg")}"\n[gpg "ssh"]\n\tprogram = "${leaves("gpg-ssh")}"\n[commit]\n\tgpgSign = true\n[tag]\n\tgpgSign = true`,
    refused: "gpg.program",
  },
  {
    name: "content filters",
    config: () =>
      `[filter "planted"]\n\tclean = "${leaves("clean", "cat")}"\n\tsmudge = "${leaves("smudge", "cat")}"\n\tprocess = "${leaves("process")}"\n\trequired = true`,
    refused: "filter.planted.clean",
  },
  {
    name: "diff drivers",
    config: () =>
      `[diff "planted"]\n\tcommand = "${leaves("diff-command")}"\n\ttextconv = "${leaves("textconv", "cat")}"\n[diff]\n\texternal = "${leaves("diff-external")}"`,
    refused: "diff.planted.command",
  },
  {
    name: "merge drivers and tools",
    config: () =>
      `[merge "planted"]\n\tdriver = "${leaves("merge-driver")}"\n[merge]\n\ttool = planted\n[mergetool "planted"]\n\tcmd = "${leaves("mergetool")}"`,
    refused: "merge.planted.driver",
  },
  {
    name: "a pack hook",
    config: () => `[uploadpack]\n\tpackObjectsHook = "${leaves("packhook")}"`,
    refused: "uploadpack.packobjectshook",
  },
  {
    name: "the remote's own programs",
    config: () =>
      `[remote "origin"]\n\tuploadpack = "${leaves("uploadpack", "git-upload-pack")}"\n\treceivepack = "${leaves("receivepack", "git-receive-pack")}"\n\tproxy = http://127.0.0.1:9\n\tvcs = planted`,
    refused: "remote.origin.receivepack",
  },
  {
    name: "an http proxy",
    config: () =>
      `[http]\n\tproxy = http://127.0.0.1:9\n[http "https://example.com"]\n\tproxy = http://127.0.0.1:9`,
    refused: "http.proxy",
  },
  {
    name: "an address rewrite",
    config: () => {
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(outside, "elsewhere.git")]);
      return `[url "${join(outside, "elsewhere.git")}"]\n\tinsteadOf = ${remote}\n\tpushInsteadOf = ${remote}`;
    },
    refused: "insteadof",
  },
  {
    name: "another config file pulled in",
    config: () => {
      writeFileSync(
        join(outside, "more"),
        `[core]\n\tsshCommand = "${leaves("included")}"\n[filter "planted"]\n\tclean = "${leaves("included-clean", "cat")}"\n`,
      );
      return `[include]\n\tpath = ${join(outside, "more")}\n[includeIf "gitdir:/"]\n\tpath = ${join(outside, "more")}`;
    },
    refused: "include.path",
  },
  {
    name: "aliases",
    config: () => `[alias]\n\tstatus = "!${leaves("alias")}"\n\tpush = "!${leaves("alias-push")}"`,
    refused: "alias.status",
  },
  {
    name: "another working copy",
    config: () => `[core]\n\tworktree = ${outside}`,
    refused: "core.worktree",
  },
  {
    name: "attributes and ignores from another file",
    config: () => {
      writeFileSync(join(outside, "attributes"), "* filter=planted\n");
      return `[core]\n\tattributesFile = ${join(outside, "attributes")}\n\texcludesFile = ${join(outside, "attributes")}`;
    },
    refused: "core.attributesfile",
  },
  {
    name: "a transport that runs a command",
    config: () =>
      `[protocol "ext"]\n\tallow = always\n[protocol]\n\tallow = always\n[remote "planted"]\n\turl = "ext::sh -c '${leaves("ext")}'"\n[branch "main"]\n\tremote = planted`,
    refused: "protocol.ext.allow",
  },
  {
    name: "a submodule update command",
    config: () =>
      `[submodule "planted"]\n\turl = ${remote}\n\tupdate = "!${leaves("submodule")}"\n\tactive = true\n[submodule]\n\trecurse = true`,
    refused: "",
  },
  {
    name: "credentials in addresses",
    config: () => `[transfer]\n\tcredentialsInUrl = allow`,
    refused: "transfer.credentialsinurl",
  },
  {
    name: "a command for an alternate's refs",
    config: () => `[core]\n\talternateRefsCommand = "${leaves("alternaterefs")}"`,
    refused: "core.alternaterefscommand",
  },
  {
    name: "a second config file for this working copy",
    config: () => {
      writeFileSync(
        join(site.root, ".git/config.worktree"),
        `[core]\n\tfsmonitor = "${leaves("worktree-config", "false")}"\n\tsshCommand = "${leaves("worktree-ssh")}"\n`,
      );
      return `[extensions]\n\tworktreeConfig = true`;
    },
    refused: "extensions.worktreeconfig",
  },
  {
    name: "a remote whose name is an option",
    config: () => `[branch "main"]\n\tremote = "--upload-pack=${leaves("option")}"`,
    refused: "branch.main.remote",
  },
  {
    name: "a line git would read and this parser does not",
    config: () => `[core]\n\tsshCommand = "${leaves("odd")}" \\x`,
    refused: "not git configuration",
  },
];

/** Every way the studio starts git in a site's folder. */
async function everything(): Promise<string> {
  const repo = new LocalRepository(site.root);
  const before = await repo.getHead();
  let said = "";
  await repo.branchState();
  await repo.syncState();
  await repo.history("content/cms/home.hero.json");
  await repo.changes(["content/cms"]);
  await repo.fileAt(before, "content/cms/home.hero.json");
  await repo.changedSince(before, "content/cms/home.hero.json");
  await originOf(site.root);
  for (const path of [
    `/sites/${SITE_ID}`,
    `/sites/${SITE_ID}/regions/home.hero`,
    `/sites/${SITE_ID}/settings`,
    `/sites/${SITE_ID}/search?q=Before`,
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- one page at a time, as a person would
    expect((await get(site, path)).status).toBeLessThan(500);
  }
  said += await (await publish("After")).text();
  said += await repo
    .commitFiles({
      message: "Direct",
      files: [{ path: "content/cms/home.hero.json", content: '{"heading":"Direct"}\n' }],
    })
    .then(
      () => "",
      (error: Error) => error.message,
    );
  const pushed = await repo.push();
  said += pushed.ok ? "" : pushed.reason;
  for (const branch of ["greatcms", "main"]) {
    // oxlint-disable-next-line no-await-in-loop -- the second switch starts from the first
    said += await repo.switchBranch(branch).then(
      () => "",
      (error: Error) => error.message,
    );
  }
  return said;
}

describe("settings planted in a site's git config", () => {
  for (const planted of PLANTED) {
    it(`runs nothing for ${planted.name}`, async () => {
      plant(planted.config());

      const said = await everything();

      expect(ran()).toEqual([]);
      if (planted.refused) {
        expect(said).toContain("git configuration has settings the studio does not work with");
        expect(said).toContain(planted.refused);
        expect(said).toContain("git config --local --unset");
        // Refused before anything was written: the content is as it was.
        expect(site.read("content/cms/home.hero.json")).toContain("Before");
      } else {
        // Husky and git's own watcher are common and harmless once switched off: publishing goes on.
        expect(said).not.toContain("git configuration");
        expect(site.read("content/cms/home.hero.json")).toContain("Direct");
      }
      expect(existsSync(join(outside, "elsewhere.git", "refs/heads/main"))).toBe(false);
    });
  }

  it("has fixtures that would run, under a git that reads the folder's config", () => {
    plant(`[filter "planted"]\n\tclean = "${leaves("clean", "cat")}"`);
    site.write("content/cms/home.hero.json", '{"heading":"Control"}\n');
    site.git(["add", "content/cms/home.hero.json"]);
    site.git(["commit", "-qm", "control"]);
    expect(ran()).toEqual(
      expect.arrayContaining(["ran-clean", "ran-hook-pre-commit", "ran-hook-post-commit"]),
    );
  });
});

describe("git as the studio runs it, whatever the config says at that moment", () => {
  /** The studio's own git, without the refusal in front: what a change made mid-request would meet. */
  const guarded = async (args: string[]) => {
    const guard = await gitIn(site.root);
    if (!guard) throw new Error("not a repository");
    return run("git", [...guard.args, ...args], {
      cwd: site.root,
      env: { ...guard.env, GIT_TERMINAL_PROMPT: "0" },
    }).then(
      ({ stdout }) => stdout,
      (error: { stderr?: string }) => `failed: ${error.stderr}`,
    );
  };

  it("stages, commits, pushes, fetches and switches with every planted setting in place", async () => {
    plant(PLANTED.map((planted) => planted.config()).join("\n"));
    site.write("content/cms/home.hero.json", '{"heading":"Racing"}\n');

    expect(await guarded(["status", "--porcelain"])).toContain("home.hero.json");
    await guarded(["add", "--", "content/cms/home.hero.json"]);
    await guarded(["diff", "--cached", "--name-only"]);
    await guarded(["diff", "HEAD"]);
    await guarded(["commit", "-m", "Racing", "--", "content/cms/home.hero.json"]);
    await guarded(["log", "-p", "-n2"]);
    await guarded(["show", "HEAD"]);
    await guarded(["push", "--porcelain", "origin", "refs/heads/main:refs/heads/main"]);
    await guarded(["fetch", "--quiet", "origin"]);
    await guarded(["switch", "--quiet", "-c", "other"]);
    await guarded(["switch", "--quiet", "main"]);
    await guarded(["checkout", "--", "."]);

    expect(ran()).toEqual([]);
    expect(
      execFileSync("git", ["log", "-1", "--format=%s", "main"], { cwd: remote, encoding: "utf8" }),
    ).toContain("Racing");
  });

  it("does not look inside a folder that has a repository of its own", async () => {
    const inner = join(site.root, "vendor/inner");
    mkdirSync(inner, { recursive: true });
    const git = (args: string[]) => execFileSync("git", args, { cwd: inner, stdio: "ignore" });
    git(["init", "-q", "-b", "main"]);
    writeFileSync(join(inner, "file.txt"), "one\n");
    git(["add", "."]);
    git(["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "inner"]);
    site.git(["add", "vendor/inner"]);
    site.git(["commit", "-qm", "a folder with its own repository"]);
    appendFileSync(
      join(inner, ".git/config"),
      `[filter "planted"]\n\tclean = "${leaves("inner-clean", "cat")}"\n[core]\n\tsshCommand = "${leaves("inner-ssh")}"\n`,
    );
    writeFileSync(join(inner, ".gitattributes"), "* filter=planted\n");
    writeFileSync(join(inner, "file.txt"), "two\n");
    forget();

    await guarded(["status", "--porcelain"]);
    await guarded(["diff", "HEAD"]);
    await guarded(["fetch", "--quiet", "origin"]);
    await everything();

    expect(ran()).toEqual([]);
  });

  it("runs no hook of a remote that is a folder on this machine", async () => {
    for (const name of ["pre-receive", "update", "post-receive", "post-update"]) {
      hook(join(remote, "hooks"), name);
    }
    appendFileSync(
      join(remote, "config"),
      `[core]\n\talternateRefsCommand = "${leaves("remote-alternates")}"\n`,
    );
    const published = await publish("To a local remote");
    expect(published.status).toBe(200);

    const pushed = await new LocalRepository(site.root).push();

    expect(pushed).toEqual({ ok: true, upstream: "origin/main" });
    expect(ran()).toEqual([]);
  });

  it("ignores a repository planted in the site's own folder", async () => {
    // A folder that looks like a bare repository is one git would otherwise find first.
    const sub = join(site.root, "packages/site");
    mkdirSync(join(sub, ".cms"), { recursive: true });
    for (const name of ["HEAD", "objects", "refs"]) {
      execFileSync("cp", ["-r", join(site.root, ".git", name), join(sub, name)]);
    }
    writeFileSync(
      join(sub, "config"),
      `[core]\n\tbare = false\n\tworktree = ${sub}\n\tfsmonitor = "${leaves("bare", "false")}"\n`,
    );
    const repo = new LocalRepository(sub);

    expect(await repo.getHead()).toBe(site.head());
    forget();
    await repo.commitFiles({
      message: "From a subfolder",
      files: [{ path: "content/note.json", content: "{}\n" }],
    });

    expect(ran()).toEqual([]);
    expect(existsSync(join(sub, "content/note.json"))).toBe(true);
    expect((await findRepository(sub))?.top).toBe(site.root);
  });

  it("refuses a config file that is a link, and reads nothing through it", async () => {
    writeFileSync(
      join(outside, "linked-config"),
      `${readFileSync(join(site.root, ".git/config"), "utf8")}\n[core]\n\tfsmonitor = "${leaves("linked", "false")}"\n`,
    );
    rmSync(join(site.root, ".git/config"));
    symlinkSync(join(outside, "linked-config"), join(site.root, ".git/config"));

    const said = await everything();

    expect(said).toContain(".git/config itself, which is a link");
    expect(ran()).toEqual([]);
  });
});

describe("repositories the studio still works with", () => {
  it("publishes and pushes on a greatcms branch with an upstream, and records the upstream itself", async () => {
    const repo = new LocalRepository(site.root);
    await repo.switchBranch("greatcms");
    expect((await publish("On a branch")).status).toBe(200);

    expect(await repo.push()).toEqual({ ok: true, upstream: "origin/greatcms" });
    // Written by the studio into the folder's real config, where the developer's git reads it.
    const real = (key: string) =>
      execFileSync("git", ["config", "--local", key], { cwd: site.root, encoding: "utf8" }).trim();
    expect(real("branch.greatcms.remote")).toBe("origin");
    expect(real("branch.greatcms.merge")).toBe("refs/heads/greatcms");
    expect(await repo.syncState()).toEqual({ upstream: "origin/greatcms", ahead: 0 });

    expect((await publish("Again")).status).toBe(200);
    expect(await repo.syncState()).toEqual({ upstream: "origin/greatcms", ahead: 1 });
    expect(await repo.push()).toEqual({ ok: true, upstream: "origin/greatcms" });
  });

  it("takes up a branch the remote already has, tracking it", async () => {
    const other = join(outside, "other");
    execFileSync("git", ["clone", "-q", remote, other]);
    const git = (args: string[]) => execFileSync("git", args, { cwd: other, stdio: "ignore" });
    git(["switch", "-q", "-c", "drafts"]);
    git([
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "theirs",
    ]);
    git(["push", "-q", "origin", "drafts"]);

    const repo = new LocalRepository(site.root);
    await repo.switchBranch("drafts");

    expect(await repo.syncState()).toEqual({ upstream: "origin/drafts", ahead: 0 });
    expect((await repo.history(".", 1)).length).toBeLessThanOrEqual(1);
    expect(
      execFileSync("git", ["log", "-1", "--format=%s"], { cwd: site.root, encoding: "utf8" }),
    ).toContain("theirs");
  });

  it("works in a linked worktree, where .git is a file", async () => {
    const tree = join(outside, "tree");
    site.git(["worktree", "add", "-q", "-b", "side", tree]);
    forget();
    plant(`[core]\n\thooksPath = ${join(outside, "hooks")}`);
    hook(join(outside, "hooks"), "pre-commit");
    const repo = new LocalRepository(tree);

    const layout = await findRepository(tree);
    expect(layout?.gitDir).toContain(".git/worktrees/tree");
    expect(layout?.commonDir).toBe(join(site.root, ".git"));
    await repo.commitFiles({
      message: "In a worktree",
      files: [{ path: "content/cms/home.hero.json", content: '{"heading":"Tree"}\n' }],
    });

    expect((await repo.branchState()).branch).toBe("side");
    expect(
      execFileSync("git", ["log", "-1", "--format=%s", "side"], {
        cwd: site.root,
        encoding: "utf8",
      }),
    ).toContain("In a worktree");
    expect(site.head()).not.toBe(await repo.getHead());
    expect(ran()).toEqual([]);
  });

  it("works after git has packed the repository's refs and objects", async () => {
    site.git(["gc", "-q"]);
    expect((await publish("After a gc")).status).toBe(200);
    expect(await new LocalRepository(site.root).push()).toEqual({
      ok: true,
      upstream: "origin/main",
    });
  });

  it("keeps the folder's private ignore list", async () => {
    appendFileSync(join(site.root, ".git/info/exclude"), "scratch/\n");
    site.write("scratch/notes.txt", "mine\n");
    await new LocalRepository(site.root).switchBranch("greatcms");
    expect((await new LocalRepository(site.root).branchState()).branch).toBe("greatcms");
  });

  it("leaves a developer's own checkout alone when told the folder is theirs", async () => {
    trustFolderGitConfig(true);
    try {
      plant(`[filter "planted"]\n\tclean = "${leaves("trusted-clean", "cat")}"`);
      expect((await publish("Trusted")).status).toBe(200);
      expect(ran()).toEqual(["ran-trusted-clean"]);
    } finally {
      trustFolderGitConfig(false);
    }
  });

  it("reads a clone's origin from the file, in a subfolder too", async () => {
    expect(await originOf(site.root)).toBe(remote);
    mkdirSync(join(site.root, "deep/er"), { recursive: true });
    expect(await originOf(join(site.root, "deep/er"))).toBe(remote);
    expect(await originOf(outside)).toBeNull();
  });

  it("is not stopped by .git/config changing between two commands", async () => {
    const config = join(site.root, ".git/config");
    const clean = readFileSync(config, "utf8");
    const repo = new LocalRepository(site.root);
    // The folder's code rewrites its config as fast as it can while the studio publishes.
    const flipping = { on: true };
    const flip = (async () => {
      for (let turn = 0; flipping.on; turn++) {
        const text =
          turn % 2 === 0
            ? `${clean}\n[core]\n\tfsmonitor = "${leaves("flip", "false")}"\n[filter "planted"]\n\tclean = "${leaves("flip-clean", "cat")}"\n`
            : clean;
        writeFileSync(`${config}.next`, text);
        renameSync(`${config}.next`, config);
        // oxlint-disable-next-line no-await-in-loop -- yields so the publish can run between flips
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    try {
      for (let round = 0; round < 15; round++) {
        // oxlint-disable-next-line no-await-in-loop -- each publish follows the last
        await repo
          .commitFiles({
            message: `Round ${round}`,
            files: [{ path: "content/cms/home.hero.json", content: `{"heading":"${round}"}\n` }],
          })
          .catch(() => undefined);
        // oxlint-disable-next-line no-await-in-loop -- as above
        await repo.changes(["content"], 5 + round);
      }
    } finally {
      flipping.on = false;
      await flip;
    }
    expect(ran()).toEqual([]);
  });
});

const verdict = (name: string, value = "x") => {
  const parts = name.split(".");
  const key = parts.pop() as string;
  const section = parts.shift() as string;
  return classify({
    section,
    subsection: parts.length ? parts.join(".") : undefined,
    key,
    value,
  });
};

describe("reading a config file", () => {
  it("reads sections, subsections, quoting, comments and continued lines", () => {
    const { entries, malformed } = parseGitConfig(
      [
        "\uFEFF# a comment",
        "[core]",
        "\tbare = false ; trailing",
        '\teditor = "vim -c \\"x\\"" # why',
        '[Remote "Or\\\\igin"] url = a\\',
        "b",
        "[branch.Main]",
        "  merge",
        "[user]\r",
        "\tname =  Two  Words  \r",
      ].join("\n"),
    );
    expect(malformed).toBe(false);
    expect(entries).toEqual([
      { section: "core", subsection: undefined, key: "bare", value: "false" },
      { section: "core", subsection: undefined, key: "editor", value: 'vim -c "x"' },
      { section: "remote", subsection: "Or\\igin", key: "url", value: "ab" },
      { section: "branch", subsection: "main", key: "merge", value: "true" },
      { section: "user", subsection: undefined, key: "name", value: "Two  Words" },
    ]);
  });

  it("marks what it cannot read, and gives git only what it could", () => {
    const checked = checkConfig(
      '[core]\n\tbare = false\n\tsshCommand = "unterminated\n[weird section]\n\tx = 1\nnot a line at all\n[user]\n\tname = "Ed\\qitor"\n',
    );
    expect(checked.problems).toContain("lines that are not git configuration");
    expect(checked.text).toBe('[core]\n\tbare = "false"\n');
  });

  it("gives git the same values back, however they were written", () => {
    const checked = checkConfig(
      '[remote "origin"]\n\turl = "https://example.com/a b\\\\c\\"d.git"\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
    );
    expect(checked.problems).toEqual([]);
    const file = join(outside, "roundtrip");
    writeFileSync(file, checked.text);
    const read = (key: string) =>
      execFileSync("git", ["config", "--file", file, key], { encoding: "utf8" }).trimEnd();
    expect(read("remote.origin.url")).toBe('https://example.com/a b\\c"d.git');
    expect(read("remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
  });

  it("keeps a short list, ignores what tools write, and refuses the rest", () => {
    for (const kept of [
      "core.repositoryformatversion",
      "core.filemode",
      "core.autocrlf",
      "remote.origin.url",
      "remote.origin.fetch",
      "remote.origin.pushurl",
      "branch.feature/x.remote",
      "branch.main.merge",
      "branch.main.rebase",
      "user.name",
      "user.email",
      "init.defaultbranch",
      "pull.rebase",
      "push.default",
      "extensions.objectformat",
      "extensions.partialclone",
    ]) {
      expect(verdict(kept), kept).toBe("keep");
    }
    for (const ignored of [
      "core.hookspath",
      "core.fsmonitor",
      "core.untrackedcache",
      "remote.origin.gh-resolved",
      "branch.main.vscode-merge-base",
      "gc.auto",
      "submodule.theme.url",
      "color.ui",
    ]) {
      expect(verdict(ignored), ignored).toBe("ignore");
    }
    for (const refused of [
      "core.sshcommand",
      "core.worktree",
      "filter.lfs.clean",
      "filter.lfs.process",
      "lfs.url",
      "lfs.repositoryformatversion",
      "credential.helper",
      "url.x.insteadof",
      "http.sslverify",
      "http.extraheader",
      "include.path",
      "includeif.gitdir:/.path",
      "extensions.worktreeconfig",
      "extensions.somethingnew",
      "remote.origin.uploadpack",
      "remote.-x.url",
      "merge.tool",
      "something.unknown",
    ]) {
      expect(verdict(refused), refused).toBe("refuse");
    }
    expect(verdict("remote.origin.url", "ext::sh -c x")).toBe("refuse");
    expect(verdict("remote.origin.url", "-oProxyCommand=x")).toBe("refuse");
    expect(verdict("branch.main.remote", "--upload-pack=x")).toBe("refuse");
    expect(verdict("branch.main.remote", ".")).toBe("keep");
  });
});
