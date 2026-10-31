/**
 * What the page shows that this form does not hold: the site's other regions, flattened to the
 * values a visitor could point at, each with the editor it opens. The header and footer are on
 * every page, so they must be reachable from every editor.
 */

import { type CmsSchema, type FieldDef, isBlocksRegion } from "@greatcms/spec";
import { fieldName } from "./form.js";
import type { SiteClient, SiteContext } from "./sites.js";
import { idFor } from "./views/fields.js";

export interface Elsewhere {
  path: string;
  dotted: string;
  label: string;
  kind: "text" | "richtext" | "image";
  value: string;
  block: { id: string; label: string };
  /** The editor that holds the field, opened at it. */
  href: string;
}

const humanize = (name: string) =>
  name.replace(/[-_]+/g, " ").replace(/^\w/, (first) => first.toUpperCase());

/** Every value in a document a person could read or point at, with the form path that holds it. */
export function flatten(
  fields: Record<string, FieldDef>,
  values: Record<string, unknown>,
  path: Array<string | number>,
  blocks: CmsSchema["blocks"],
  out: Omit<Elsewhere, "block" | "href">[],
): void {
  for (const [name, def] of Object.entries(fields)) {
    const value = values?.[name];
    const at = [...path, name];
    const label = def.label ?? humanize(name);
    const push = (kind: Elsewhere["kind"], text: unknown, p = at) => {
      if (typeof text === "string" && text.trim().length > 1) {
        out.push({ path: fieldName(p), dotted: p.join("."), label, kind, value: text });
      }
    };
    switch (def.type) {
      case "text":
        push("text", value);
        break;
      case "richtext":
        push("richtext", (value as { html?: string } | undefined)?.html);
        break;
      case "image":
        push("image", (value as { src?: string } | undefined)?.src, [...at, "src"]);
        break;
      case "link":
        push("text", (value as { label?: string } | undefined)?.label, [...at, "label"]);
        break;
      case "group":
        flatten(def.fields, (value ?? {}) as Record<string, unknown>, at, blocks, out);
        break;
      case "list":
        if (Array.isArray(value)) {
          value.forEach((item, index) =>
            // An item is named after its list, not "Item".
            flatten(
              { item: { ...def.of, label: def.of.label ?? label } },
              { item },
              [...at, index],
              blocks,
              out,
            ),
          );
        }
        break;
      case "blocks":
        if (Array.isArray(value)) {
          value.forEach((item, index) => {
            const type = String((item as { _type?: unknown })?._type ?? "");
            const definition = blocks[type];
            if (definition) {
              flatten(
                definition.fields,
                item as Record<string, unknown>,
                [...at, index],
                blocks,
                out,
              );
            }
          });
        }
        break;
      default:
        break;
    }
  }
}

/** Every region except the one being edited, as what the page shows of it. */
export async function regionsElsewhere(
  client: SiteClient,
  context: SiteContext,
  siteId: string,
  except?: string,
): Promise<Elsewhere[]> {
  const regions = Object.entries(context.schema.regions).filter(([id]) => id !== except);
  const documents = await Promise.all(
    regions.map(async ([regionId]) => {
      const draft = await client.readLiveDraft({ context, regionId });
      return draft ?? (await client.resolvedRegion(context, regionId));
    }),
  );
  const out: Elsewhere[] = [];
  regions.forEach(([regionId, region], index) => {
    const document = documents[index] ?? {};
    const label = region.label ?? regionId;
    const values: Omit<Elsewhere, "block" | "href">[] = [];
    if (isBlocksRegion(region)) {
      flatten(
        { blocks: { type: "blocks", allow: region.allow } },
        document,
        [],
        context.schema.blocks,
        values,
      );
    } else {
      flatten(region.fields, document, [], context.schema.blocks, values);
    }
    const href = `/sites/${siteId}/regions/${regionId}`;
    for (const value of values) {
      // A dotted path's id is what the editor scrolls to when it opens.
      const id = idFor(value.dotted.split("."));
      out.push({
        ...value,
        block: { id: `region:${regionId}`, label },
        href: `${href}#${id}`,
      });
    }
  });
  return out;
}
