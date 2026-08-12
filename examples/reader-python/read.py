#!/usr/bin/env python3
"""A complete GreatCMS reader in Python, written from SPEC.md alone.

It exists to keep the project honest: if integrating in a new language needs
more than this file's worth of code, the standard has drifted toward whatever is
convenient for JavaScript, and that is a bug.

    python3 read.py <site-dir> [<out-dir>]

With <out-dir>, it writes <region-id>.json for every region, which the
conformance verifier then checks:

    node packages/conformance/bin/greatcms-conformance.mjs verify <out-dir>
"""

from __future__ import annotations

import json
import os
import sys

import yaml

DEFAULT_REGIONS_DIR = "content/cms"


def load_schema(site_dir: str) -> dict:
    """Schema may be YAML or JSON — YAML parses both, so one loader covers it."""
    for name in ("schema.json", "schema.yaml", "schema.yml"):
        path = os.path.join(site_dir, ".cms", name)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as handle:
                schema = yaml.safe_load(handle)
            if schema.get("version") != 1:
                raise SystemExit(f"{path}: unsupported spec version {schema.get('version')}")
            return schema
    raise SystemExit(f"{site_dir}: no .cms/schema.yaml found")


def load_config(site_dir: str) -> dict:
    for name in ("config.json", "config.yaml", "config.yml"):
        path = os.path.join(site_dir, ".cms", name)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as handle:
                return yaml.safe_load(handle) or {}
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


def resolve_region(schema: dict, region_id: str, stored: dict | None) -> dict | None:
    region = (schema.get("regions") or {}).get(region_id)
    if region is None:
        return None

    if region.get("type") == "blocks":
        if not stored or not isinstance(stored.get("blocks"), list):
            return {"blocks": region.get("default", [])}
        blocks = []
        for block in stored["blocks"]:
            block_def = (schema.get("blocks") or {}).get(block.get("_type")) if isinstance(block, dict) else None
            if block_def is None or not isinstance(block, dict):
                blocks.append(block)
            else:
                blocks.append(deep_merge(field_defaults(block_def.get("fields", {})), block))
        return {**stored, "blocks": blocks}

    defaults = deep_merge(field_defaults(region.get("fields", {})), region.get("default", {}))
    return deep_merge(defaults, stored or {})


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

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
