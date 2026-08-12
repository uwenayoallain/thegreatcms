/**
 * @greatcms/spec — the GreatCMS content standard.
 *
 * This package is a convenience, not a requirement. The standard is the files:
 * `.cms/schema.yaml`, `.cms/config.yaml`, and JSON/Markdown content. Any tool in
 * any language can read those without this package, which is the entire point.
 */

export { SpecError, SpecIssue, IssueBag, type SpecIssueInit } from './errors.js';

export {
  FIELD_TYPES,
  FieldDefSchema,
  selectOptions,
  type FieldDef,
  type FieldType,
  type FileValue,
  type ImageValue,
  type LinkValue,
  type RichTextValue,
} from './fields.js';

export {
  SPEC_VERSION,
  REGION_ID_RE,
  SchemaFileSchema,
  parseSchema,
  isBlocksRegion,
  fieldsOf,
  type BlockDef,
  type BlocksRegion,
  type CmsSchema,
  type CollectionDef,
  type ParseSchemaOptions,
  type RegionDef,
  type SingleRegion,
} from './schema.js';

export { ConfigFileSchema, DEFAULT_CONFIG, parseConfig, type CmsConfig } from './config.js';

export {
  collectionEntryPath,
  mediaFilePath,
  mediaUrl,
  regionFilePath,
  regionIdFromPath,
  slugify,
} from './paths.js';

export {
  validateFields,
  validateRegion,
  type ValidateOptions,
  type ValidationResult,
} from './validate.js';

export {
  fieldDefaults,
  parseRegionFile,
  regionDefaults,
  resolveRegion,
  serializeRegion,
  type RegionDocument,
  type RegionMeta,
} from './content.js';

export { parseFrontmatter, serializeFrontmatter, type Frontmatter } from './markdown.js';
