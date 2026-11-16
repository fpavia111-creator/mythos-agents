# Changelog

## 0.2.0 — 2026-11-15

Requires `mythos-agent-core` ^0.2.0.

### Added
- Tokenizer-based analysis (`src/lexer.js`, no dependencies) instead of line regexes: `nlapi`/`nlobj` calls and `N/` module names inside comments, strings, template text and regex literals are no longer counted; calls inside template `${...}` expressions are.
- `define([...], callback)` and `require(...)` dependency lists with aliases (function, arrow and single-parameter forms, and `var x = require('N/x')`). New fields: `modules`, `custom_dependencies`, `aliases`, `unmapped`, `redesign`.
- Effort estimate per file and in total (`effort`, `effort_hours`), explained by counted signals; optional `estimate_config` (config schema `estimate_config`) to calibrate the weights.
- `epimetheus_dependency_graph`: custom-module graph, cycles (Tarjan), stable conversion order (libraries first), unresolved paths, Mermaid diagram.
- `epimetheus_progress`: compare an earlier `inventory.csv` with the folder now.
- `epimetheus_write_sarif`: SARIF 2.1.0 output for code scanning.
- `inventory.csv` gains `effort_hours`, `conversion_order` and `depends_on`; the test plan gains effort and dependency-order sections. Report tools return `output_sha256` (recorded in the audit line).
- MCP prompt `epimetheus_conversion_plan`; tool titles.

### Changed
- `@NApiVersion`/`@NScriptType` are read from comments only (a string containing `@NApiVersion` no longer counts).
- `loc` now counts lines that hold code tokens (lines that are only inside a block comment are no longer counted).
- The "declares 2.x but contains nlapi/nlobj calls" signal now also applies to `2.x` and `2.1` files (it was 2.0 only).
- `limit` on `epimetheus_inventory` must be a whole number ≥ 1.

Deploy stays blocked in every mode.

### Hardening (review pass)

- Test plan hash is taken from the text as written.
- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

