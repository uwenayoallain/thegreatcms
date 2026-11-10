/** `.cms/config.yaml`: where content lives in this repo and how publishing behaves. */

import { parse as parseYaml } from "yaml";
import { IssueBag } from "./errors.js";
import { SPEC_VERSION, yamlProblem } from "./schema.js";
import {
  type Parser,
  type Problem,
  type Property,
  type Shape,
  INVALID,
  describe,
  fail,
  object,
  optional,
  record,
  repoPath,
  required,
  string,
  withDefault,
} from "./shape.js";

export interface CmsConfig {
  version: number;
  content: {
    /** Directory for structured region JSON. */
    regions: string;
    /** Directory uploads are committed into. */
    media: string;
  };
  /** URL prefix the site serves `content.media` from. */
  mediaUrlPrefix: string;
  publish: {
    // branch, draftBranchPrefix and dispatchEvent are no longer read; older configs still parse.
    branch: string;
    draftBranchPrefix: string;
    commitMessage: string;
    dispatchEvent?: string | null;
  };
  preview?: {
    // urlTemplate is no longer read; older configs still parse.
    urlTemplate?: string | null;
    /**
     * Where an entry is seen on the site, per collection: a path with `{slug}`,
     * or a map of slug to path with `"*"` as the fallback, e.g.
     * `pages: { home: "/", "*": "/{slug}" }`. The studio's preview opens it.
     */
    paths?: Record<string, string | Record<string, string>>;
  };
}

const relPath = repoPath;

const nullableString: Parser<string | null> = (value, at, problems) =>
  value === null ? null : string()(value, at, problems);

/** A section with nothing but comments under it means its defaults. */
function section(shape: Shape, fallback?: () => Record<string, unknown>): Property {
  return { parse: object(shape), default: fallback, nullIsAbsent: true };
}

const publishDefaults = () => ({
  branch: "main",
  draftBranchPrefix: "cms/draft",
  commitMessage: "content: update {summary}",
});

const configFile = object({
  version: required(
    (value, at, problems) =>
      typeof value === "number" && Number.isInteger(value) && value > 0
        ? value
        : fail(problems, at, `Expected a version number, found ${describe(value)}.`),
    `Start the file with \`version: ${SPEC_VERSION}\`.`,
  ),
  content: section(
    {
      regions: withDefault(relPath, () => "content/cms"),
      media: withDefault(relPath, () => "public/media"),
    },
    () => ({ regions: "content/cms", media: "public/media" }),
  ),
  mediaUrlPrefix: withDefault(string(), () => "/media"),
  publish: section(
    {
      branch: withDefault(string(), () => "main"),
      draftBranchPrefix: withDefault(string(), () => "cms/draft"),
      commitMessage: withDefault(string(), () => "content: update {summary}"),
      dispatchEvent: optional(nullableString),
    },
    publishDefaults,
  ),
  preview: section({
    urlTemplate: optional(nullableString),
    paths: optional(
      record((value, at, problems) =>
        typeof value === "string" ? value : record(string())(value, at, problems),
      ),
    ),
  }),
});

function readConfigFile(raw: unknown, problems: Problem[]): CmsConfig | typeof INVALID {
  const parsed = configFile(raw, "", problems);
  return parsed === INVALID ? INVALID : (parsed as unknown as CmsConfig);
}

export const DEFAULT_CONFIG: CmsConfig = readConfigFile({ version: SPEC_VERSION }, []) as CmsConfig;

export function parseConfig(source: string, file = ".cms/config.yaml"): CmsConfig {
  const bag = new IssueBag(file);

  let raw: unknown;
  try {
    raw = parseYaml(source) ?? {};
  } catch (err) {
    bag.add(yamlProblem(err));
    bag.throwIfAny("Could not read config");
    /* c8 ignore next */
    throw err;
  }

  const problems: Problem[] = [];
  const config = readConfigFile(raw, problems);
  if (config === INVALID) {
    for (const problem of problems) {
      bag.add({ code: "invalid_config", ...problem, path: problem.path || undefined });
    }
    bag.throwIfAny("Config is not valid");
    /* c8 ignore next */
    throw new Error("unreachable");
  }
  if (config.version !== SPEC_VERSION) {
    bag.add({
      code: "unsupported_version",
      path: "version",
      message: `Config declares version ${config.version}, but this tool supports version ${SPEC_VERSION}.`,
      fix: `Set \`version: ${SPEC_VERSION}\`.`,
    });
    bag.throwIfAny("Config is not valid");
  }

  return config;
}

const own = (map: Record<string, string>, key: string) =>
  Object.hasOwn(map, key) && typeof map[key] === "string" ? map[key] : undefined;

/**
 * Where an entry is seen on the site, from `preview.paths`: the slug's own
 * path, else the `*` template, else the front page. A region is seen at the
 * path named by its id, else the front page too.
 */
export function previewPath(
  config: CmsConfig,
  entry?: { collection: string; slug: string } | { region: string },
): string {
  if (!entry) return "/";
  const paths = config.preview?.paths;
  if ("region" in entry) {
    const path = paths && Object.hasOwn(paths, entry.region) ? paths[entry.region] : undefined;
    return typeof path === "string" && sitePath(path) && !path.includes("{slug}") ? path : "/";
  }
  const rule =
    paths && Object.hasOwn(paths, entry.collection) ? paths[entry.collection] : undefined;
  const template =
    typeof rule === "string" ? rule : rule ? (own(rule, entry.slug) ?? own(rule, "*")) : undefined;
  if (!template || !sitePath(template)) return "/";
  return template.replaceAll("{slug}", encodeURIComponent(entry.slug));
}

/** A path on the site itself: `/work/{slug}`, never `//host`, `https:` or `javascript:`. */
const sitePath = (path: string) => path.startsWith("/") && !/^\/[\\/]/.test(path);
