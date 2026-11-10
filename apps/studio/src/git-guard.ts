/**
 * Git in a site's folder, without acting on what the folder's own `.git/config` says. The site's
 * code can write that file, so it is read here as text and git is handed a copy holding only the
 * settings on a short list: what git reads is what was checked, whatever the folder says later.
 */

import { createHash } from "node:crypto";
import {
  constants,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/** Hooks, the file-watcher program and command remotes never run, whoever configured them. */
export const SAFE_GIT = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  // A remote spelled `ext::command` is a command, whatever the folder's own config allows.
  "-c",
  "protocol.ext.allow=never",
];

/** A folder inside the working copy with a `.git` of its own is never entered. */
const GUARDED_GIT = [
  ...SAFE_GIT,
  "-c",
  "submodule.recurse=false",
  "-c",
  "fetch.recurseSubmodules=false",
  "-c",
  "push.recurseSubmodules=no",
  "-c",
  "diff.ignoreSubmodules=all",
];

/** A program on the other end of a push or fetch to a folder on this machine, run without its hooks. */
const LOCAL_END =
  "git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.alternateRefsCommand=true -c receive.denyCurrentBranch=refuse";

let trusted = false;

/**
 * Whether a folder's own git configuration is the operator's, as it is for `greatcms studio` on a
 * developer's checkout. Off, the studio reads a short list of settings from it and nothing else.
 */
export function trustFolderGitConfig(trust: boolean): void {
  trusted = trust;
}

export interface GitLayout {
  /** The folder holding `.git`: the top of the working copy. */
  top: string;
  /** Where this working copy keeps HEAD and its index. */
  gitDir: string;
  /** Where the repository keeps its config, objects and refs: `gitDir`, except in a worktree. */
  commonDir: string;
}

export interface ConfigEntry {
  section: string;
  subsection?: string;
  key: string;
  value: string;
}

const MAX_CONFIG_BYTES = 512 * 1024;

/** A small file read without following a link, or null when it is missing, a link, or too large. */
async function readPlain(path: string, limit = MAX_CONFIG_BYTES): Promise<string | null> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > limit) return null;
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Finds the repository a folder belongs to the way git does, by reading and never by running. */
export async function findRepository(root: string): Promise<GitLayout | null> {
  for (let folder = resolve(root); ; folder = dirname(folder)) {
    const dotGit = join(folder, ".git");
    // oxlint-disable-next-line no-await-in-loop -- each folder up is only looked at if this one had none
    const info = await stat(dotGit).catch(() => null);
    if (info?.isDirectory()) return withCommon(folder, dotGit);
    if (info?.isFile()) {
      // A worktree or submodule: `.git` is a file naming the real folder.
      return fromPointer(folder, dotGit);
    }
    if (dirname(folder) === folder) return null;
  }
}

async function fromPointer(folder: string, file: string): Promise<GitLayout | null> {
  const pointer = /^gitdir: (.+)$/m.exec((await readPlain(file, 4096)) ?? "");
  return pointer ? withCommon(folder, resolve(folder, (pointer[1] as string).trim())) : null;
}

async function withCommon(top: string, gitDir: string): Promise<GitLayout> {
  const common = (await readPlain(join(gitDir, "commondir"), 4096))?.trim();
  return { top, gitDir, commonDir: common ? resolve(gitDir, common) : gitDir };
}

/**
 * Git's config format, strictly: a line this does not understand marks the file malformed and is
 * dropped. Git never reads the original, so reading it differently from git cannot matter.
 */
export function parseGitConfig(text: string): { entries: ConfigEntry[]; malformed: boolean } {
  const entries: ConfigEntry[] = [];
  let malformed = false;
  let section: string | null = null;
  let subsection: string | undefined;
  const lines = (text.codePointAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?(?:\n|$)/);
  for (let index = 0; index < lines.length; index++) {
    let line = (lines[index] as string).trimStart();
    if (line.startsWith("[")) {
      const header =
        /^\[([A-Za-z0-9-]+)(?:\.([A-Za-z0-9.-]+))?(?:[ \t]+"((?:[^"\\]|\\.)*)")?\][ \t]*(.*)$/.exec(
          line,
        );
      if (!header || (header[2] !== undefined && header[3] !== undefined)) {
        malformed = true;
        section = null;
        continue;
      }
      section = (header[1] as string).toLowerCase();
      subsection = header[3]?.replace(/\\(.)/g, "$1") ?? header[2]?.toLowerCase();
      line = header[4] as string;
    }
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const pair = /^([A-Za-z][A-Za-z0-9-]*)[ \t]*(?:=[ \t]*(.*))?$/.exec(line);
    if (!pair || section === null) {
      malformed = true;
      continue;
    }
    let raw = pair[2];
    let value = "";
    let ok = true;
    if (raw === undefined) value = "true";
    else {
      let quoted = false;
      let pendingSpace = "";
      for (let at = 0; at < raw.length; at++) {
        const char = raw[at] as string;
        if (char === "\\") {
          const next = raw[at + 1];
          if (next === undefined) {
            // A backslash ending the line carries the value onto the next one.
            if (index + 1 >= lines.length) break;
            raw = `${raw.slice(0, at)}${lines[++index] as string}`;
            at--;
            continue;
          }
          const escaped = { n: "\n", t: "\t", b: "\b", '"': '"', "\\": "\\" }[next];
          if (escaped === undefined) ok = false;
          value += pendingSpace + (escaped ?? "");
          pendingSpace = "";
          at++;
        } else if (char === '"') {
          quoted = !quoted;
          value += pendingSpace;
          pendingSpace = "";
        } else if (!quoted && (char === "#" || char === ";")) break;
        else if (!quoted && (char === " " || char === "\t")) pendingSpace += char;
        else {
          value += pendingSpace + char;
          pendingSpace = "";
        }
      }
      if (quoted) ok = false;
    }
    // oxlint-disable-next-line no-control-regex -- a control character in a value is never legitimate
    if (!ok || /[\u0000-\u0008\u000b-\u001f]/.test(value)) malformed = true;
    else entries.push({ section, subsection, key: pair[1]!.toLowerCase(), value });
  }
  return { entries, malformed };
}

const set = (names: string) => new Set(names.split(" "));

/** Settings that only say how the repository is laid out and where its branches go. */
const KEPT: Record<string, Set<string>> = {
  core: set(
    "repositoryformatversion filemode bare logallrefupdates ignorecase precomposeunicode symlinks autocrlf eol safecrlf sparsecheckout sparsecheckoutcone trustctime checkstat quotepath",
  ),
  user: set("name email"),
  init: set("defaultbranch"),
  pull: set("rebase ff"),
  push: set("default autosetupremote followtags"),
  fetch: set("prune prunetags"),
  merge: set("ff conflictstyle"),
  remote: set("pushdefault"),
  // The hash and ref formats, a partial clone's remote, and "never prune": none names a program.
  extensions: set("objectformat refstorage partialclone preciousobjects"),
};
const KEPT_REMOTE = set(
  "url pushurl fetch push tagopt prune prunetags mirror promisor partialclonefilter skipdefaultupdate skipfetchall",
);
const KEPT_BRANCH = set("remote merge rebase pushremote description");

/** Settings tools write that change nothing the studio does: left out of the copy, and not a reason to stop. */
const IGNORED_SECTIONS = set(
  "color advice column gui gc maintenance pack index feature status rerere submodule",
);
const IGNORED: Record<string, Set<string>> = {
  // Husky sets hooksPath on install; hooks and the watcher are switched off for every command anyway.
  core: set(
    "hookspath fsmonitor untrackedcache fscache preloadindex splitindex commitgraph multipackindex longpaths compression loosecompression bigfilethreshold abbrev fsync fsyncmethod",
  ),
  extensions: set("relativeworktrees"),
};
const IGNORED_REMOTE = set("gh-resolved");
const IGNORED_BRANCH = set("vscode-merge-base gh-merge-base github-pr-owner-number");

/** A remote or branch-remote name that cannot be read as an option. */
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
/** `helper::address` runs `git-remote-helper`; a leading dash is an option. */
const UNSAFE_URL = /^(?:-|[A-Za-z0-9][A-Za-z0-9+.-]*::)/;

type Verdict = "keep" | "ignore" | "refuse";

/** What the studio does with one setting from a folder's own config. */
export function classify(entry: ConfigEntry): Verdict {
  const { section, subsection, key, value } = entry;
  if (section === "remote" && subsection !== undefined) {
    if (IGNORED_REMOTE.has(key)) return "ignore";
    if (!KEPT_REMOTE.has(key) || !REMOTE_NAME.test(subsection)) return "refuse";
    return (key === "url" || key === "pushurl") && UNSAFE_URL.test(value) ? "refuse" : "keep";
  }
  if (section === "branch" && subsection !== undefined) {
    if (IGNORED_BRANCH.has(key)) return "ignore";
    if (!KEPT_BRANCH.has(key) || subsection.includes("\n")) return "refuse";
    const names = key === "remote" || key === "pushremote";
    return names && value !== "." && !REMOTE_NAME.test(value) ? "refuse" : "keep";
  }
  if (IGNORED_SECTIONS.has(section)) return "ignore";
  if (subsection !== undefined) return "refuse";
  if (KEPT[section]?.has(key)) return "keep";
  return IGNORED[section]?.has(key) ? "ignore" : "refuse";
}

/** A setting's name as `git config` spells it, safe to show. */
function nameOf(entry: ConfigEntry): string {
  const middle =
    entry.subsection === undefined
      ? ""
      : // oxlint-disable-next-line no-control-regex -- a name is shown on a page
        `.${entry.subsection.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 60)}`;
  return `${entry.section}${middle}.${entry.key}`;
}

const quote = (value: string) =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;

/** The kept settings, written the plainest way git reads. */
function serialize(entries: ConfigEntry[]): string {
  return entries
    .map(({ section, subsection, key, value }) => {
      const sub =
        subsection === undefined
          ? ""
          : ` "${subsection.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      return `[${section}${sub}]\n\t${key} = ${quote(value)}\n`;
    })
    .join("");
}

export interface CheckedConfig {
  /** The config git is given. */
  text: string;
  /** Settings the studio will not work with, by name; empty when there are none. */
  problems: string[];
  entries: ConfigEntry[];
}

/** Sorts a folder's config into what git is given and what stops a publish. */
export function checkConfig(text: string | null): CheckedConfig {
  if (text === null) {
    return {
      text: "",
      entries: [],
      problems: [".git/config itself, which is a link, missing, or too large to be a config file"],
    };
  }
  const { entries, malformed } = parseGitConfig(text);
  const kept = entries.filter((entry) => classify(entry) === "keep");
  const refused = [...new Set(entries.filter((entry) => classify(entry) === "refuse").map(nameOf))];
  if (malformed) refused.push("lines that are not git configuration");
  return { text: serialize(kept), entries, problems: refused };
}

/** Why the studio will not publish, push or change branch in a folder, for its owner. */
export function configRefusal(problems: string[]): Refusal {
  const shown = problems.slice(0, 8).join(", ");
  const more = problems.length > 8 ? `, and ${problems.length - 8} more` : "";
  return {
    message: `This folder's git configuration has settings the studio does not work with: ${shown}${more}. Nothing was changed.`,
    fix: "the site's own code can write .git/config, so the studio reads only a short list of settings from it. Remove each one in the site's folder (git config --local --unset <name>, or edit .git/config), or set it for the whole machine (git config --global) if it is yours.",
  };
}

type Refusal = { message: string; fix: string };

/**
 * An object store named by `objects/info/alternates` that lies outside the repository, or null.
 * Git reads objects from wherever that file says, and the site's code can write it.
 */
async function borrowedStore(objects: string, within: string, depth = 0): Promise<string | null> {
  const file = join(objects, "info", "alternates");
  const text = await readPlain(file);
  if (text === null) {
    const present = await lstat(file).then(
      () => true,
      () => false,
    );
    return present ? "a file the studio will not read" : null;
  }
  for (const line of text.split(/\r?\n/)) {
    if (line === "" || line.startsWith("#")) continue;
    const target = resolve(objects, line);
    // Git follows a chain of these five deep; a quoted line is a path spelled another way.
    if (line.startsWith('"') || depth >= 5 || !target.startsWith(`${within}${sep}`)) {
      // oxlint-disable-next-line no-control-regex -- the path is shown on a page
      return line.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 200);
    }
    // oxlint-disable-next-line no-await-in-loop -- a chain is followed one link at a time
    const deeper = await borrowedStore(target, within, depth + 1);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * A link in the object store that leads outside the repository, or null: `objects` itself, or a
 * folder in it such as `pack`, pointed at another repository reads that one's objects just as
 * an alternates file would.
 */
async function linkedStore(objects: string, within: string): Promise<string | null> {
  // The repository's own real path: its folder may itself be reached through a link.
  const home = await realpath(within).catch(() => within);
  const outside = async (path: string) => {
    const real = await realpath(path).catch(() => null);
    return real === null || !(real === home || real.startsWith(`${home}${sep}`));
  };
  const top = await lstat(objects).catch(() => null);
  if (!top) return null;
  if (top.isSymbolicLink()) return (await outside(objects)) ? "objects" : null;
  const entries = await readdir(objects, { withFileTypes: true }).catch(() => []);
  const links = entries.filter((entry) => entry.isSymbolicLink());
  const answers = await Promise.all(links.map((entry) => outside(join(objects, entry.name))));
  const found = links.find((_, index) => answers[index]);
  return found ? `objects/${found.name.replace(/[^\w.-]/g, "?").slice(0, 60)}` : null;
}

function linkedRefusal(name: string): Refusal {
  return {
    message: `This folder's repository reaches git objects outside itself (.git/${name} is a link that leads out of it), so the studio does not run git in it. Nothing was changed.`,
    fix: "the site's own code can make that link, and through it git would read another repository on this machine. In the site's folder replace the link with a real folder holding the repository's own objects, or clone the site afresh.",
  };
}

/** Why the studio runs no git in a folder whose objects come from outside it, for its owner. */
function borrowedRefusal(store: string): Refusal {
  return {
    message: `This folder's repository takes git objects from outside itself (.git/objects/info/alternates names ${store}), so the studio does not run git in it. Nothing was changed.`,
    fix: "the site's own code can write that file, and through it git would read another repository on this machine. In the site's folder run `git repack -a -d`, then delete .git/objects/info/alternates.",
  };
}

/** Folders and files of the repository git is pointed at through the copy. */
const LINKED = ["objects", "refs", "packed-refs", "logs", "shallow", "reftable", "worktrees"];

let base: string | undefined;
const copies = new Map<
  string,
  { dir: string; config?: string; exclude?: string; linked: boolean }
>();

function replaceFile(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * A folder only the studio can write that stands in for the repository's own: the checked config,
 * and links to its objects and refs. No hooks folder and no attributes file exist in it.
 */
async function copyFor(layout: GitLayout, config: string): Promise<string> {
  if (!base) {
    base = mkdtempSync(join(tmpdir(), "greatcms-git-"));
    const made = base;
    process.once("exit", () => rmSync(made, { recursive: true, force: true }));
  }
  let copy = copies.get(layout.commonDir);
  if (!copy) {
    const name = createHash("sha256").update(layout.commonDir).digest("hex").slice(0, 24);
    copy = { dir: join(base, name), linked: false };
    mkdirSync(join(copy.dir, "info"), { recursive: true, mode: 0o700 });
    copies.set(layout.commonDir, copy);
  }
  if (!copy.linked) {
    // Git writes each branch's log under here; without the folder it would write into the copy.
    await mkdir(join(layout.commonDir, "logs"), { recursive: true }).catch(() => undefined);
    for (const name of LINKED) {
      try {
        symlinkSync(join(layout.commonDir, name), join(copy.dir, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    copy.linked = true;
  }
  if (copy.config !== config) {
    replaceFile(join(copy.dir, "config"), config);
    copy.config = config;
  }
  // The folder's private ignore list is patterns, never a program.
  const exclude = (await readPlain(join(layout.commonDir, "info", "exclude"))) ?? "";
  if (copy.exclude !== exclude) {
    replaceFile(join(copy.dir, "info", "exclude"), exclude);
    copy.exclude = exclude;
  }
  return copy.dir;
}

export interface GitRun {
  /** Goes before the git command's own arguments. */
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Settings in the folder's config that stop a publish, push or branch change. */
  problems: string[];
  /** Why the studio will not publish, push or change branch here, or null when it will. */
  refusal: Refusal | null;
  /** Git is not run here at all, even to read: what it would read is not this repository's. */
  blocked: boolean;
  /** The repository's real config file, when the studio writes a branch's upstream itself. */
  configFile?: string;
}

/** How to run git in a site's folder, or null when the folder is in no repository. */
export async function gitIn(root: string): Promise<GitRun | null> {
  if (trusted) {
    return { args: SAFE_GIT, env: process.env, problems: [], refusal: null, blocked: false };
  }
  const layout = await findRepository(root);
  if (!layout) return null;
  const configFile = join(layout.commonDir, "config");
  const checked = checkConfig(await readPlain(configFile));
  const copy = await copyFor(layout, checked.text);
  const borrowed = await borrowedStore(join(layout.commonDir, "objects"), layout.commonDir);
  const linked = borrowed
    ? null
    : await linkedStore(join(layout.commonDir, "objects"), layout.commonDir);
  return {
    args: GUARDED_GIT,
    env: {
      ...process.env,
      // Named outright, so git neither searches for a repository nor reads this one's config.
      GIT_DIR: layout.gitDir,
      GIT_COMMON_DIR: copy,
      GIT_WORK_TREE: layout.top,
      GIT_EDITOR: ":",
    },
    problems: checked.problems,
    refusal: borrowed
      ? borrowedRefusal(borrowed)
      : linked
        ? linkedRefusal(linked)
        : checked.problems.length > 0
          ? configRefusal(checked.problems)
          : null,
    blocked: borrowed !== null || linked !== null,
    configFile,
  };
}

/** Whether a remote's address is a folder on this machine. */
export function isLocalRemote(url: string): boolean {
  if (/^file:/i.test(url)) return true;
  return !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url) && !/^[^/]*:/.test(url);
}

/** Arguments that run the far end of a push or fetch without its hooks, when it is on this machine. */
export function localEnd(run: GitRun, url: string | null, pack: "receive" | "upload"): string[] {
  if (run.configFile === undefined || !url || !isLocalRemote(url)) return [];
  return [`--${pack}-pack=${LOCAL_END} ${pack}-pack`];
}

/** Records a branch's upstream in the repository's real config, which git was not given to write. */
export async function trackBranch(run: GitRun, branch: string, remote: string): Promise<void> {
  if (run.configFile === undefined) return;
  const handle = await open(
    run.configFile,
    constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) return;
    await handle.appendFile(
      serialize([
        { section: "branch", subsection: branch, key: "remote", value: remote },
        { section: "branch", subsection: branch, key: "merge", value: `refs/heads/${branch}` },
      ]),
    );
  } finally {
    await handle.close();
  }
}

/** Where a folder's `origin` remote points, or null: read from the file, so nothing runs. */
export async function originFromConfig(path: string): Promise<string | null> {
  const layout = await findRepository(path);
  if (!layout) return null;
  const text = await readPlain(join(layout.commonDir, "config"));
  if (text === null) return null;
  const url = parseGitConfig(text).entries.findLast(
    (entry) => entry.section === "remote" && entry.subsection === "origin" && entry.key === "url",
  );
  return url?.value.trim() || null;
}
