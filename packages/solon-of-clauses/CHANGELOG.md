# Changelog

Not legal advice. Solon checks text against your own playbook and does not replace a lawyer.

## 0.2.0

- **DOCX input**: `.docx` contracts are read directly with zero dependencies (unzip through `node:zlib`). One paragraph is one line. Tracked changes are read as accepted and flagged (`docx_tracked_changes`), comments are counted (`docx_comments`), and automatic numbering is flagged (`docx_auto_numbering`).
- **Defined-terms check** in `solon_check`: capitalised terms used but not defined, terms defined but unused, and terms defined twice, with lines. Playbook option `ignore_terms`.
- **Playbook versioning**: optional `version`, `updated` and `owner`. The memo cites the playbook version and the playbook file's SHA-256 prefix.
- **Redline of the memo**: `solon_draft_markup` takes `previous_draft` and writes `issues-for-counsel.diff`; with `previous_contract` the memo gains a "Changes since" section.
- **`solon_compare_drafts`** (allow): two drafts against one playbook, clause by clause, with new and resolved findings and changed sections. `solon_write_report` takes `previous_contract` and writes `draft-changes.md` and `contract.diff`.
- **`playbook` config schema** (`solon-of-clauses validate-config playbook <file>`): unknown keys, wrong types and missing fields fail with JSON-pointer errors. Playbooks with keys outside the documented ones are now refused.
- `solon_write_report` returns `output_sha256` (recorded in the audit log).
- MCP prompt `contract_playbook_review`.
- Unchanged: `e_sign` and `send_email` stay blocked; `solon_request_send` stays one click after a named reviewer, in every mode.

Hardening (review pass)

- `draft_sha256` is the hash of the memo as written. A blank `reviewed_by` on `solon_request_send` is refused before anyone is asked to approve.
- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

