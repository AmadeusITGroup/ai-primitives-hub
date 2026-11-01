# Governance rule catalogue

Generated from `packages/core/src/domain/governance/rule-registry.ts`. Do not edit by hand;
build the required packages with `pnpm --filter @ai-primitives-hub/app... run build`,
then regenerate with `pnpm -C packages/app run generate:rule-catalogue`.

Any error fails the run. Warnings do not fail the run.
Unverified findings retain their severity and can fail the run when reported as errors.

Floor rules cannot be disabled or downgraded in `hub-governance.yml`. Configuration rules (CFG)
are evaluated before any policy applies and cannot be configured.

| Rule | Applies to | Default | Floor | Configurable | Needs network | Description |
| --- | --- | --- | --- | --- | --- | --- |
| AGT001 | primitive | warning | no | yes | no | Agent file is \*.agent.md with frontmatter: description, and tools as a list of strings |
| BOD001 | primitive | warning | no | yes | no | Markdown primitive has a non-empty instruction body |
| CFG001 | hub, collection, primitive | error | — | no | no | Governance configuration is readable YAML matching hub-governance.schema.json |
| CFG002 | hub, collection, primitive | error | — | no | no | Governance configuration references only known, configurable rule ids |
| CFG003 | hub, collection, primitive | error | — | no | no | Governance configuration does not disable or downgrade a floor rule |
| COL001 | collection | error | yes | yes | no | Collection IDs and names are unique within the repository |
| COL002 | collection | error | yes | yes | yes | Collection has a published release |
| COL003 | collection | error | no | yes | no | Collection author is non-empty |
| COL004 | collection | error | no | yes | yes | Collection ID is unique across enabled Hub sources |
| COL005 | collection | error | yes | yes | no | Collection structure and referenced files are valid |
| COL006 | collection | warning | no | yes | no | Collection validation advisories |
| HUB001 | hub | error | yes | yes | no | Hub syntax, schema, references and source policies |
| HUB002 | hub | warning | no | yes | no | Hub validation advisories |
| INS001 | primitive | warning | no | yes | no | Instruction file is \*.instructions.md with frontmatter applyTo glob(s) |
| MCP001 | primitive | warning | no | yes | no | MCP server definition has command or url, and every $\{input:id\} is declared |
| MCP002 | primitive | warning | no | yes | no | MCP server env and headers contain no literal secrets |
| MCP003 | primitive | error | no | yes | no | MCP transport fields and input definitions have valid structure |
| PRM001 | primitive | warning | no | yes | no | Prompt file is \*.prompt.md with frontmatter: description, and a valid agent or mode |
| PTH001 | primitive | error | yes | yes | no | Primitive paths resolve inside the repository without escaping symlinks |
| SKL001 | primitive | error | yes | yes | no | Agent Skills specification and folder validation |
| SKL002 | primitive | warning | no | yes | no | Skill validation advisories |
