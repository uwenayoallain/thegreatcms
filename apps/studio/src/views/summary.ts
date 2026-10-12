/** What a collapsed block or list item says about itself. */

import { type BlockDef, blockVariants } from "@greatcms/spec";
import { html } from "hono/html";

/** "Navy panel" for a block whose `_variant` is `navy`; nothing for a block without variants. */
export function variantLabel(
  item: Record<string, unknown>,
  definition: BlockDef | undefined,
): string {
  const variants = blockVariants(definition);
  if (variants.length === 0) return "";
  const named = String(item._variant ?? "");
  return (variants.find((v) => v.value === named) ?? variants[0]!).label;
}

/** A select for the block's variants, or nothing. */
export function variantField(
  item: Record<string, unknown>,
  definition: BlockDef | undefined,
  name: string,
  id: string,
) {
  const variants = blockVariants(definition);
  if (variants.length === 0) return "";
  const named = String(item._variant ?? variants[0]!.value);
  return html`<div class="field field-variant">
    <label for="${id}">Variant</label>
    <select id="${id}" name="${name}">
      ${variants.map(
        (v) =>
          html`<option value="${v.value}" ${v.value === named ? "selected" : ""}>
            ${v.label}
          </option>`,
      )}
    </select>
  </div>`;
}

/** The line that stands for a collapsed item: its title-like field, else the first words it has. */
export function summarize(
  item: Record<string, unknown>,
  definition: BlockDef | undefined,
  empty: string,
): string {
  for (const key of ["heading", "title", "question", "label", "name"]) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const key of Object.keys(definition?.fields ?? {})) {
    if (key === "_type") continue;
    const value = item[key];
    if (typeof value === "string" && value.trim()) {
      const text = value.trim().replace(/\s+/g, " ");
      return text.length > 60 ? `${text.slice(0, 57)}…` : text;
    }
  }
  const count = Object.keys(definition?.fields ?? {}).length;
  return count > 0 ? `${count} ${count === 1 ? "field" : "fields"}` : empty;
}
