# Changelog

## 0.2.0 — 2026-11-16

Added (handoff ver 6)
- Readiness report (Markdown and HTML) in nine languages: `language` argument or `--lang`. Codes, findings.json and exceptions.csv stay in English; translated reports say they are Claude translations pending native review.
- Key, amount, account and balance columns found by their names in eight languages; Shift_JIS, GBK, EUC-KR and Windows-1252 exports read.

Fixed
- "1.234" in a column with decimal commas was read as 1.234; each column now has one decimal mark. Japanese headers no longer all compare as the same empty name.

Requires `mythos-agent-core` ^0.2.0.

### Added (handoff ver 5)
- Memory: `olympus_recall`, `olympus_learn`, `olympus_accept_learning` and `olympus_retire_memory`, plus `olympus-of-migration memory list|accept|reject|retire|verify`. Olympus can remember a customer's column names (used only when the call and config leave a setting unset; disagreeing facts are left out) and extra field rules (added after the config's; a config rule with the same id wins; nested-quantifier patterns refused). Tolerances, FX rates and the base currency cannot be learned. A fact applies only after a named person accepts it (one click, never on Auto). Results list the facts used under `memory`; the readiness report (Markdown and HTML) and `findings.json` (`learned_facts`) say which were used. `olympus_check_fields` runs with learned rules alone when no rules or config are given. `--no-memory` runs without it.

### Added
- Configurable tolerance (`tolerance`, default 0.005; differences up to and including it tie) on compare, tie-out and the report.
- Trial-balance tie-out by subsidiary and currency: `subsidiary_column`, `currency_column`, `fx_rates` and `base_currency`. A currency with no rate is reported as unknown (`missing_fx_rates`), never guessed. Per-subsidiary summary in `by_subsidiary`.
- Per-subsidiary amount totals in `olympus_compare_exports` (`subsidiary_column`).
- `olympus_check_fields`: field rules (required, unique, number/integer/date, enum, pattern, min/max, max_length, severity) with spreadsheet row numbers.
- `olympus_compare_runs`: compare two `findings.json` files from successive trial loads.
- `migration_rules` config schema (`config` argument; `validate-config migration_rules <file>`).
- Readiness report now also writes `readiness-report.html` and `exceptions.csv`, includes a prioritised next-actions list, field-rule results, and an optional "change since previous run" section (`previous_findings`).
- Signed readiness report: the report returns `output_sha256` (hash of all written files), which the runtime records in the audit line; with `--signing-key` the line is Ed25519-signed.
- MCP prompt `olympus_go_live_readiness`.
- Tool titles for MCP hosts; accurate input schemas (validated before a tool runs).

### Changed
- Trial-balance lines where any row of the account has a blank or non-numeric balance are now reported as unknown instead of summing the remaining rows (stricter; never guesses a partial balance).
- `findings.json` gains `rules`, `field_rules`, `actions` and (optional) `change_since_previous` keys.

### Not done
- Saved-search (SuiteTalk) connector: depends on the shared connector work (A3); not started.

Go-live stays blocked in every mode.

### Hardening (review pass)

- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

