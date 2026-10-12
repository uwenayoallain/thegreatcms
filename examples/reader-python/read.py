#!/usr/bin/env python3
"""A complete GreatCMS reader in Python, written from SPEC.md alone.

It exists to keep the project honest: if integrating in a new language needs
more than this file's worth of code, the standard has drifted toward whatever is
convenient for JavaScript, and that is a bug.

    python3 read.py <site-dir> [<out-dir>]

With <out-dir>, it writes <region-id>.json for every region and
entries/<collection>/<slug>.json for every collection entry, which the
conformance verifier then checks:

    node packages/conformance/bin/greatcms-conformance.mjs verify <out-dir>
"""

from __future__ import annotations

import json
import os
import re
import sys

import yaml

DEFAULT_REGIONS_DIR = "content/cms"


class SpecLoader(yaml.SafeLoader):
    """YAML 1.2, which is what the standard reads.

    PyYAML implements YAML 1.1, where `no`, `on` and `off` are booleans, `0777` is
    octal, `1:30` is ninety, and `2026-08-14` is a date object. Under 1.2 the
    first four are what they look like, and a `date` field is an ISO 8601 string.
    A reader that kept 1.1 would turn a tag called "no" into `false`, so the
    implicit types are replaced with the 1.2 core schema's rather than patched.
    """

    def construct_mapping(self, node, deep=False):
        keys = [self.construct_object(key, deep=deep) for key, _ in node.value]
        duplicate = next((key for key in keys if keys.count(key) > 1), None)
        if duplicate is not None:
            raise yaml.constructor.ConstructorError(
                None, None, f"duplicate key {duplicate!r}", node.start_mark
            )
        return super().construct_mapping(node, deep=deep)


def _int_1_2(loader, node):
    value = loader.construct_scalar(node)
    if value.startswith(("0o", "0x")):
        return int(value[2:], 8 if value[1] == "o" else 16)
    return int(value, 10)


SpecLoader.yaml_implicit_resolvers = {}
for tag, pattern, first in [
    ("tag:yaml.org,2002:null", r"^(?:~|null|Null|NULL|)$", ["~", "n", "N", ""]),
    ("tag:yaml.org,2002:bool", r"^(?:true|True|TRUE|false|False|FALSE)$", list("tTfF")),
    ("tag:yaml.org,2002:int", r"^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$", list("-+0123456789")),
    (
        "tag:yaml.org,2002:float",
        r"^(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?"
        r"|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$",
        list("-+.0123456789"),
    ),
]:
    SpecLoader.add_implicit_resolver(tag, re.compile(pattern), first)
SpecLoader.add_constructor("tag:yaml.org,2002:int", _int_1_2)


def load_yaml(source: str):
    return yaml.load(source, Loader=SpecLoader)


def load_file(path: str):
    """A `.json` file is JSON: YAML would refuse one indented with tabs."""
    with open(path, encoding="utf-8") as handle:
        source = handle.read()
    return json.loads(source) if path.endswith(".json") else load_yaml(source)


def load_schema(site_dir: str) -> dict:
    for name in ("schema.json", "schema.yaml", "schema.yml"):
        path = os.path.join(site_dir, ".cms", name)
        if os.path.exists(path):
            schema = load_file(path)
            if schema.get("version") != 1:
                raise SystemExit(f"{path}: unsupported spec version {schema.get('version')}")
            return schema
    raise SystemExit(f"{site_dir}: no .cms/schema.yaml found")


def load_config(site_dir: str) -> dict:
    for name in ("config.json", "config.yaml", "config.yml"):
        path = os.path.join(site_dir, ".cms", name)
        if os.path.exists(path):
            return load_file(path) or {}
    return {}


def regions_dir(config: dict) -> str:
    return (config.get("content") or {}).get("regions", DEFAULT_REGIONS_DIR)


def field_defaults(fields: dict) -> dict:
    """Defaults declared on the fields themselves. Lists default to absent."""
    out: dict = {}
    for name, field in (fields or {}).items():
        kind = field.get("type")
        if kind == "group":
            nested = field_defaults(field.get("fields", {}))
            if nested:
                out[name] = nested
        elif kind == "list":
            continue
        elif kind == "blocks":
            if "default" in field:
                out[name] = field["default"]
        elif "default" in field:
            out[name] = field["default"]
    return out


def deep_merge(base: dict, over: dict) -> dict:
    """Objects merge deeply; arrays and scalars are replaced wholesale."""
    out = dict(base)
    for key, value in over.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def resolve_block(schema: dict, block):
    """One block with its defaults, then the same for anything nested in it."""
    if not isinstance(block, dict):
        return block
    block_def = (schema.get("blocks") or {}).get(block.get("_type"))
    if block_def is None:
        return block
    fields = block_def.get("fields", {})
    resolved = resolve_nested(schema, fields, deep_merge(field_defaults(fields), block))
    # A block with variants always carries one: the first, unless the content names another.
    variants = [v if isinstance(v, str) else v.get("value") for v in block_def.get("variants") or []]
    if variants:
        named = resolved.get("_variant")
        resolved["_variant"] = named if named in variants else variants[0]
    return resolved


def resolve_nested(schema: dict, fields: dict, document: dict) -> dict:
    """Walks `blocks` fields, so nesting is resolved at every depth."""
    out = dict(document)
    for name, field in (fields or {}).items():
        value = out.get(name)
        kind = field.get("type")
        if kind == "blocks" and isinstance(value, list):
            out[name] = [resolve_block(schema, entry) for entry in value]
        elif kind == "group" and isinstance(value, dict):
            out[name] = resolve_nested(schema, field.get("fields", {}), value)
    return out


def resolve_region(schema: dict, region_id: str, stored: dict | None) -> dict | None:
    region = (schema.get("regions") or {}).get(region_id)
    if region is None:
        return None

    if region.get("type") == "blocks":
        if not stored or not isinstance(stored.get("blocks"), list):
            return {"blocks": region.get("default", [])}
        return {**stored, "blocks": [resolve_block(schema, b) for b in stored["blocks"]]}

    fields = region.get("fields", {})
    defaults = deep_merge(field_defaults(fields), region.get("default", {}))
    return resolve_nested(schema, fields, deep_merge(defaults, stored or {}))


EXTENSIONS = {"markdown": ".md", "mdx": ".mdx", "json": ".json"}


def parse_frontmatter(source: str) -> tuple[dict, str]:
    """A line that is exactly `---`, YAML, another such line, then the body verbatim."""
    lines = source.removeprefix("\ufeff").split("\n")
    is_fence = lambda line: line.removesuffix("\r") == "---"  # noqa: E731
    if not is_fence(lines[0]):
        return {}, source
    for index in range(1, len(lines)):
        if is_fence(lines[index]):
            data = load_yaml("\n".join(line.removesuffix("\r") for line in lines[1:index])) or {}
            return data, "\n".join(lines[index + 1 :])
    return {}, source


def read_entries(site_dir: str, collection: dict) -> list[dict]:
    """A collection entry is what its file says: frontmatter plus the body field.

    Schema defaults are deliberately not applied here. They are an authoring
    convenience for a new entry, not a read-time rule — an entry that exists
    says what it says.
    """
    extension = EXTENSIONS.get(collection.get("format", "markdown"), ".md")
    directory = os.path.join(site_dir, collection["path"])
    if not os.path.isdir(directory):
        return []

    entries = []
    for name in sorted(os.listdir(directory)):
        if not name.endswith(extension):
            continue
        with open(os.path.join(directory, name), encoding="utf-8") as handle:
            source = handle.read()
        slug = name[: -len(extension)]

        if extension == ".json":
            entries.append({"slug": slug, "data": json.loads(source)})
            continue

        data, body = parse_frontmatter(source)
        body_field = collection.get("body")
        if body_field:
            data[body_field] = body
        entries.append({"slug": slug, "data": data})
    return entries


def read_region(site_dir: str, schema: dict, config: dict, region_id: str) -> dict | None:
    path = os.path.join(site_dir, regions_dir(config), f"{region_id}.json")
    stored = None
    if os.path.exists(path):  # a missing file is the normal, un-edited case
        with open(path, encoding="utf-8") as handle:
            stored = json.load(handle)
    return resolve_region(schema, region_id, stored)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__.strip())
        return 2

    site_dir = argv[1]
    out_dir = argv[2] if len(argv) > 2 else None

    schema = load_schema(site_dir)
    config = load_config(site_dir)

    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    for region_id in (schema.get("regions") or {}):
        resolved = read_region(site_dir, schema, config, region_id)
        if out_dir:
            with open(os.path.join(out_dir, f"{region_id}.json"), "w", encoding="utf-8") as handle:
                json.dump(resolved, handle, indent=2)
                handle.write("\n")
        else:
            print(f"# {region_id}")
            print(json.dumps(resolved, indent=2))

    for name, collection in (schema.get("collections") or {}).items():
        for entry in read_entries(site_dir, collection):
            if out_dir:
                directory = os.path.join(out_dir, "entries", name)
                os.makedirs(directory, exist_ok=True)
                path = os.path.join(directory, f"{entry['slug']}.json")
                with open(path, "w", encoding="utf-8") as handle:
                    json.dump(entry, handle, indent=2)
                    handle.write("\n")
            else:
                print(f"# {name}/{entry['slug']}")
                print(json.dumps(entry, indent=2))

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
