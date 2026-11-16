# Changelog

## 0.2.0 — 2026-11-15

Requires `mythos-agent-core` ^0.2.0.

### Added
- Signed log verification: `public_keys` on `eirene_verify_chain`, `eirene_summarize_logs` and `eirene_build_evidence` checks Ed25519 signatures (via core `verifyChain`), follows signed key rotations, and reports `signing`, `key_ids` and `key_rotations`. A re-chained tampered log fails with its line number.
- Control mapping: `eirene_map_controls`; control lists accept `match_any`, glob values, `evidence_files`, `frequency` and `owner`, in the 0.1 array form or `{ name, controls }`. Every evidence item in `control-evidence.csv` cites a control id; gaps (`gaps.csv`), stale evidence by frequency, and unmapped events are reported. `events.csv` gains `control_ids`.
- `controls` config schema (`validate-config controls <file>`); bundled starter templates `agent-guardrails` and `itgc-starter` (`eirene_list_templates`, or `template` on map/build). Placeholders to rename; not official framework mappings.
- `eirene_diff_evidence`: compare two evidence folders by path and SHA-256 (added, removed, changed, unchanged, carried over). `previous_evidence_dir` on build writes `evidence-diff.csv`.
- Evidence folder adds `index.html`, `evidence-files.csv` (with `evidence_dir`) and a Signing column; the build returns `output_sha256` (the manifest's hash), which the runtime records in the audit line.
- MCP prompt `eirene_evidence_review`; tool titles; stricter input schemas (`logs` must be a non-empty array, dates must start with YYYY-MM-DD).

### Changed
- Key-rotation lines are recognised as mythos-format events (`tool: key_rotation`) and are not counted as human approvals.
- Control matching accepts any glob in a value (previously only a trailing `*`); existing patterns behave the same.

Sending evidence stays blocked in every mode.

### Hardening (review pass)

- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

