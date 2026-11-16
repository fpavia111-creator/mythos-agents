# Changelog

## 0.2.0

- **OpenAPI drift**: pass `openapi` (an OpenAPI 3.x or Swagger 2.0 spec as JSON). Endpoints in the docs (`GET /notes/{id}`, `curl -X DELETE https://…/notes/1`) that the spec does not have, a different HTTP method than the spec, spec operations no doc mentions, and deprecated operations documented without saying so. The server base path is stripped and templated paths match concrete ones.
- **CHANGELOG vs version**: an existing `CHANGELOG.md` with no entry for the package.json version, entries newer than package.json, and duplicate entries are flagged; `require_changelog` also flags a package with none.
- **`echo_ci`** (allow): CI gate that writes `echo-of-docs.sarif` (SARIF 2.1.0, paths relative to `--root`) and `drift.json` with line-independent fingerprints. `fail_on` (error, warning, any, none), `baseline` with new and fixed findings, and `new_only`. Returns `output_sha256` (recorded in the audit log).
- **`echo-of-docs ci`** command that exits 1 when the gate fails, and a **GitHub Action** (`action.yml`) plus an example workflow (`examples/docs-drift.yml`) that uploads the SARIF to code scanning.
- **`docs_config` config schema** (`config` argument, `echo-of-docs validate-config docs_config <file>`); typos fail with JSON-pointer errors. `pack` may come from the config file instead of the arguments.
- `echo_write_report` returns `output_sha256`.
- MCP prompt `docs_drift_review` for the end-to-end workflow.
- MCP prompt names are no longer reported as missing tools: names in the tool file's `prompts` list, or under a heading about prompts, are skipped.

Hardening (review pass)

- The tool list file may carry `config_schemas` (names that are not tools), so a schema name that shares a tool prefix is no longer reported as a missing tool. Proposed doc copies are written byte for byte (`raw`).
- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

