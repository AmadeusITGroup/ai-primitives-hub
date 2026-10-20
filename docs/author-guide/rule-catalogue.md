# Governance rule catalogue

Generated from `packages/core/src/domain/governance/rule-registry.ts`. Do not edit by hand;
regenerate with `pnpm -C packages/app run generate:rule-catalogue`.

Every run starts at a score of 100 and loses 10 points per error and 3 per warning.
Findings whose data could not be verified carry no score weight. Any error fails the run;
the score fails it only when a minimum score is set.

Floor rules cannot be disabled or downgraded in `hub-governance.yml`. Configuration rules (CFG)
are evaluated before any policy applies and cannot be configured.

| Rule | Applies to | Default | Floor | Configurable | Needs network | Description |
| --- | --- | --- | --- | --- | --- | --- |
| AGT001 | primitive | warning | no | yes | no | Agent file is \*.agent.md with frontmatter: description, and tools as a list of strings |
| CFG001 | hub, collection, primitive | error | — | no | no | Governance configuration is readable YAML matching hub-governance.schema.json |
| CFG002 | hub, collection, primitive | error | — | no | no | Governance configuration references only known, configurable rule ids |
| CFG003 | hub, collection, primitive | error | — | no | no | Governance configuration does not disable or downgrade a floor rule |
| CFG004 | hub, collection, primitive | error | — | no | no | Minimum score is a number between 0 and 100 |
| COL001 | collection | error | yes | yes | no | Collection IDs and names are unique within the repository |
| COL002 | collection, hub | error | yes | yes | yes | Collection has a published release |
| COL003 | collection | error | no | yes | no | Collection author is non-empty |
| COL004 | hub | error | no | yes | yes | Collection ID is unique across enabled Hub sources |
| COL005 | collection | error | yes | yes | no | Collection structure and referenced files are valid |
| COL006 | collection | warning | no | yes | no | Collection validation advisories |
| HUB001 | hub | error | yes | yes | no | Hub syntax, schema, references and source policies |
| HUB002 | hub | warning | no | yes | no | Hub validation advisories |
| INS001 | primitive | warning | no | yes | no | Instruction file is \*.instructions.md with frontmatter applyTo glob(s) |
| MCP001 | primitive | warning | no | yes | no | MCP server definition has command or url, and every $\{input:id\} is declared |
| MCP002 | primitive | warning | no | yes | no | MCP server env and headers contain no literal secrets |
| PRM001 | primitive | warning | no | yes | no | Prompt file is \*.prompt.md with frontmatter: description, and a valid agent or mode |
| SKL001 | primitive | error | yes | yes | no | Agent Skills specification and folder validation |
| SKL002 | primitive | warning | no | yes | no | Skill validation advisories |
