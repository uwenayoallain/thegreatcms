/** `.cms/config.yaml` — where content lives in this repo and how publishing behaves. */

import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { IssueBag } from "./errors.js";
import { SPEC_VERSION } from "./schema.js";

const relPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.includes(".."), {
    message: "Must be a repo-relative path that does not escape the repository.",
  });

/** A YAML key with nothing but comments under it parses as `null`. */
const optionalSection = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => value ?? undefined, schema);

export const ConfigFileSchema = z.object({
  version: z.number().int().positive(),
  content: optionalSection(
    z
      .object({
        /** Directory for structured region JSON. */
        regions: relPath.default("content/cms"),
        /** Directory uploads are committed into. */
        media: relPath.default("public/media"),
      })
      .default({ regions: "content/cms", media: "public/media" }),
  ),
  /** URL prefix the site serves `content.media` from. */
  mediaUrlPrefix: z.string().default("/media"),
  publish: optionalSection(
    z
      .object({
        branch: z.string().default("main"),
        draftBranchPrefix: z.string().default("cms/draft"),
        commitMessage: z.string().default("content: update {summary}"),
        /** Fire a repository_dispatch after publishing, for CI that needs a nudge. */
        dispatchEvent: z.string().optional(),
      })
      .default({
        branch: "main",
        draftBranchPrefix: "cms/draft",
        commitMessage: "content: update {summary}",
      }),
  ),
  preview: optionalSection(
    z
      .object({
        /** `{branch}` is substituted; used to iframe the site's own CI preview. */
        urlTemplate: z.string().optional(),
      })
      .optional(),
  ),
});

export type CmsConfig = z.infer<typeof ConfigFileSchema>;

export const DEFAULT_CONFIG: CmsConfig = ConfigFileSchema.parse({ version: SPEC_VERSION });

export function parseConfig(source: string, file = ".cms/config.yaml"): CmsConfig {
  const bag = new IssueBag(file);

  let raw: unknown;
  try {
    raw = parseYaml(source) ?? {};
  } catch (err) {
    bag.add({
      code: "invalid_yaml",
      message: `File is not valid YAML: ${(err as Error).message}`,
      fix: "Check indentation — YAML requires spaces, never tabs.",
    });
    bag.throwIfAny("Could not read config");
    /* c8 ignore next */
    throw err;
  }

  const parsed = ConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      bag.add({
        code: "invalid_config",
        path: issue.path.join(".") || undefined,
        message: issue.message,
      });
    }
    bag.throwIfAny("Config is not valid");
  }

  const config = parsed.data as CmsConfig;
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
