# Validating Collections

Validate your collection files before publishing to catch errors early.

## Quick Validation

```bash
Ctrl+Shift+P → "Prompt Registry: Validate Collections"
```

Validates all `.collection.yml` files in your `collections/` directory, including:
- Schema validation (required fields, formats)
- File reference checking (all referenced files exist)
- Duplicate detection (no duplicate IDs or names across collections)

## What Gets Validated

| Check | Description |
|-------|-------------|
| Required fields | `id`, `name`, `description`, `items` |
| ID format | Lowercase letters, numbers, hyphens only |
| Item paths | Valid relative paths |
| Item kinds | One of: `prompt`, `instruction`, `agent`, `skill` |
| File references | Referenced files exist |
| Duplicate IDs | No two collections share the same ID |
| Duplicate names | No two collections share the same name |

## Common Errors

**Missing required field**
→ Add the missing `id`, `name`, `description`, or `items` field

**Invalid ID format**
→ Use only lowercase letters, numbers, and hyphens (e.g., `my-collection`)

**Invalid item kind**
→ Use one of: `prompt`, `instruction`, `agent`, `skill`

**File not found**
→ Check that the path in `items[].path` points to an existing file

**Duplicate collection ID**
→ Each collection must have a unique ID across the repository

**Duplicate collection name**
→ Each collection must have a unique name across the repository

## See Also

- [Collection Schema](./collection-schema.md) — Full YAML reference
- [Creating Collections](./creating-source-bundle.md) — Getting started
