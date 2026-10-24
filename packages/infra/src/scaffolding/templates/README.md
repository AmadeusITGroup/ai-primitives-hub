# Scaffolding templates

Each subdirectory is one template set: a `manifest.json` that lists the template
files and their `{{variable}}` placeholders, plus the template files themselves.
`TemplateEngine` (`../template-engine.ts`) renders them.

## JSON templates

Values substituted into `*.json.template` and `*.json` templates are
JSON-string-escaped, so a value containing `"` or `\` still renders valid JSON.
The escaping is chosen by filename, not by placeholder position. A placeholder
in a JSON template must therefore sit inside a string literal (`"{{name}}"`).
An unquoted placeholder for a raw array, number or object (`"tags": {{tags}}`)
would be escaped as a string fragment and corrupt the output.
