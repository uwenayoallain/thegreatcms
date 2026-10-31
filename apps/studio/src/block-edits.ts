/** Adding, moving and removing blocks, top-level and nested, as a form action asks. */

import type { CmsSchema, CollectionDef, FieldDef, RegionDef } from "@greatcms/spec";
import { fieldName } from "./form.js";
import type { RegionDocument } from "@greatcms/spec";

export interface BlockActionResult {
  changed: boolean;
  open?: number;
}

export function applyBlockAction(
  action: string,
  blocks: Array<Record<string, unknown>>,
  addType: string,
  allowed: string[],
): BlockActionResult {
  const [verb, rawIndex] = action.split(":");
  const index = Number(rawIndex);

  if (verb === "add" || action === "add") {
    if (!allowed.includes(addType)) return { changed: false };
    blocks.push({ _type: addType });
    return { changed: true, open: blocks.length - 1 };
  }
  if (!Number.isInteger(index) || index < 0 || index >= blocks.length) {
    return { changed: false };
  }

  if (verb === "remove") {
    blocks.splice(index, 1);
    return { changed: true };
  }
  const target = verb === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= blocks.length) return { changed: false };
  const [moved] = blocks.splice(index, 1);
  if (moved) blocks.splice(target, 0, moved);
  return moved ? { changed: true, open: target } : { changed: false };
}

/** Applies the same add/remove/reorder controls to a blocks field at any depth. */
export function applyNestedBlockAction(
  schema: CmsSchema,
  root: RegionDef | CollectionDef,
  document: RegionDocument,
  action: string,
  form: FormData,
): { changed: boolean; open?: string } {
  const [, verb, encodedPath, rawIndex] = action.split(":");
  if (!verb || !encodedPath || !["add", "remove", "up", "down"].includes(verb)) {
    return { changed: false };
  }

  const path = encodedPath.split(".");
  const target = nestedBlockList(schema, root, document, path);
  if (!target) return { changed: false };

  const addType = String(form.get(fieldName(path, "nestedAdd")) ?? "");
  if (verb === "add" && !target.allowed.includes(addType)) return { changed: false };
  const updated = applyBlockAction(
    rawIndex === undefined ? verb : `${verb}:${rawIndex}`,
    target.blocks,
    addType,
    target.allowed,
  );
  return {
    changed: updated.changed,
    open: updated.open === undefined ? encodedPath : `${encodedPath}.${updated.open}`,
  };
}

export function nestedParentBlock(action: string): number | undefined {
  const encodedPath = action.split(":")[2];
  const [root, rawIndex] = encodedPath?.split(".") ?? [];
  const index = Number(rawIndex);
  return root === "blocks" && Number.isInteger(index) && index >= 0 ? index : undefined;
}

export function nestedBlockList(
  schema: CmsSchema,
  root: RegionDef | CollectionDef,
  document: RegionDocument,
  path: string[],
): { blocks: Array<Record<string, unknown>>; allowed: string[] } | null {
  let node = document as Record<string, unknown>;
  let fields: Record<string, FieldDef>;
  let offset = 0;

  if ("type" in root && root.type === "blocks") {
    if (path[0] !== "blocks") return null;
    const item = indexedBlock(node.blocks, path[1]);
    if (!item) return null;
    const definition = schema.blocks[String(item._type ?? "")];
    if (!definition) return null;
    node = item;
    fields = definition.fields;
    offset = 2;
  } else {
    fields = root.fields;
  }

  while (offset < path.length) {
    const name = path[offset];
    if (!name) return null;
    const definition = fields[name];
    if (!definition) return null;

    if (offset === path.length - 1) {
      if (definition.type !== "blocks") return null;
      const current = node[name];
      const blocks = Array.isArray(current) ? (current as Array<Record<string, unknown>>) : [];
      if (!Array.isArray(current)) node[name] = blocks;
      return { blocks, allowed: definition.allow };
    }

    if (definition.type === "group") {
      const child = objectValue(node[name]);
      node[name] = child;
      node = child;
      fields = definition.fields;
      offset += 1;
      continue;
    }

    if (definition.type !== "blocks") return null;
    const item = indexedBlock(node[name], path[offset + 1]);
    if (!item) return null;
    const block = schema.blocks[String(item._type ?? "")];
    if (!block) return null;
    node = item;
    fields = block.fields;
    offset += 2;
  }

  return null;
}

export function indexedBlock(
  value: unknown,
  rawIndex: string | undefined,
): Record<string, unknown> | null {
  if (!Array.isArray(value) || !rawIndex || !/^\d+$/.test(rawIndex)) return null;
  const item = value[Number(rawIndex)];
  return typeof item === "object" && item !== null && !Array.isArray(item)
    ? (item as Record<string, unknown>)
    : null;
}

export function objectValue(
  value: unknown,
  fallback: Record<string, unknown> = {},
): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fallback;
}
