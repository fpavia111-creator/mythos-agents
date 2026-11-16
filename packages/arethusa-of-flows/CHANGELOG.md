# Changelog

## 0.2.0 — 2026-11-15

Fixed (handoff ver 6)
- Proposals for flows named in non-Latin scripts all went to `flow.json`; file names keep the script and same-named files are numbered.

### Added
- Power Automate / Logic Apps flow definitions and Workato recipe exports. The same checks run on them: `runAfter` builds the step graph (disconnected steps, error routes on `Failed`/`TimedOut`), conditions and Workato `if` blocks count as filters before deletes, Workato `catch` blocks count as error routes, `skip: true` steps are disabled, and Power Automate HTTP triggers open to anyone are reported as `open_webhook`.
- Secret detection with about 20 known formats, secret-named fields and Shannon entropy. Known formats and secret-named fields stay `hardcoded_secret` (high); entropy-only hits are a new `possible_secret` (medium). Findings name the rule (for example "Slack incoming-webhook URL") and location, never the value. Redaction keeps URL hosts and parameter names and replaces only the secret part.
- `arethusa_dependency_map` (report, allow): shared credentials, hardcoded secrets (labelled `secret#n`), webhooks and hosts across flows; flow-to-flow calls through n8n webhook paths; a prioritised secret rotation plan; `dependency-map.md` with a Mermaid graph and `dependency-map.csv`.
- `findings.sarif` (SARIF 2.1.0) from `arethusa_write_report`.
- `baseline` argument on `arethusa_audit` and `arethusa_write_report`: new, existing and resolved findings against an earlier `findings.csv`.
- Optional policy file (`policy` config schema): allowed plain-HTTP hosts, thresholds, entropy settings and suppressions that require a reason and can expire. `arethusa-of-flows validate-config policy <file>`.
- MCP prompt `arethusa_flow_review`.
- `output_sha256` on report and dependency-map results (recorded in the audit line).
- Fixtures: `power-automate-flow.json`, `workato-recipes.json`, `arethusa-policy.json` (fictional; all secret-looking values start with FAKE).

### Changed
- Secret findings now say which rule matched. A token-like, high-entropy value in a field without a secret-like name is reported as `possible_secret`; before 0.2.0 it was not reported. Existing fixtures, tests and evals give the same results as before.

### Hardening (review pass)

- Markdown report hashes are taken from the text as written.
- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

