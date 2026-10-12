/** @greatcms/spec — the GreatCMS content standard. */

export { SpecError, SpecIssue, IssueBag, type SpecIssueInit } from "./errors.js";

export {
  FIELD_TYPES,
  FieldDefSchema,
  conditionMet,
  selectOptions,
  type FieldCondition,
  type FieldDef,
  type FieldType,
  type FileValue,
  type ImageValue,
  type LinkValue,
  type RichTextValue,
} from "./fields.js";

export {
  SPEC_VERSION,
  REGION_ID_RE,
  SchemaFileSchema,
  parseSchema,
  unknownSchemaKeys,
  isBlocksRegion,
  blockVariants,
  fieldsOf,
  type BlockDef,
  type BlocksRegion,
  type CmsSchema,
  type CollectionDef,
  type ParseSchemaOptions,
  type RegionDef,
  type SingleRegion,
} from "./schema.js";

export {
  ConfigFileSchema,
  DEFAULT_CONFIG,
  parseConfig,
  previewPath,
  type CmsConfig,
} from "./config.js";

export {
  collectionEntryPath,
  DRAFT_DIR,
  draftFilePath,
  entryExtension,
  hasFrontmatter,
  isSafeSlug,
  type CollectionFormat,
  mediaFilePath,
  mediaUrl,
  regionFilePath,
  regionIdFromPath,
  slugify,
} from "./paths.js";

export {
  validateFields,
  validateRegion,
  type ValidateOptions,
  type ValidationResult,
} from "./validate.js";

export {
  fieldDefaults,
  parseRegionFile,
  regionDefaults,
  resolveRegion,
  serializeRegion,
  type RegionDocument,
  type RegionMeta,
} from "./content.js";

export { parseFrontmatter, serializeFrontmatter, type Frontmatter } from "./markdown.js";
