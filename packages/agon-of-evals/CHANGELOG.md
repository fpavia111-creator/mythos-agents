# Changelog

## 0.2.0 (2026-11-15)

### Added
- Repeated trials: several responses per case give a pass rate, flaky cases and a suite `pass_threshold`.
- Statistical regression thresholds: `agon_compare` returns `stats` with a seeded bootstrap confidence interval on the score change and a `regression` / `improvement` / `within_noise` verdict; per-case Fisher exact tests with trials, an exact sign test without; `min_delta`, `confidence`, `resamples`, `seed`.
- `agon_grade_rubric`: rubric grading where every grade cites the criterion and its evidence. Check-based criteria quote the matching text; recorded judgments are verified (known criterion, quote present in the output).
- `agon_write_dashboard`: self-contained offline `dashboard.html` (no scripts, no network requests, deterministic bytes) plus `dashboard.json`, with regressions between runs highlighted.
- Gate files (`min_score`, `max_regressions`, `fail_on`, `must_pass`, `max_flaky`, `min_rubric_score`, `require_comparable`) on `agon_grade`, `agon_compare`, `agon_write_report` and `agon_write_dashboard`.
- New checks: `json_schema`, `tool_order`, `tool_args`, `max_tool_calls`. Cases can carry `tags`, `critical` and `notes`; results include per-tag pass rates, critical failures and a 95% Wilson interval on cases passed.
- Config schemas `agon-suite`, `agon-rubric`, `agon-gate` (also `validate-config`); MCP prompt `agon_eval_run`; `output_sha256` in the audit log for report tools.
- `agon_compare` also lists `added_cases` and `removed_cases` (built on the core's `compareEvals`).

### Changed
- Suites are now checked against a schema before grading: unknown keys at the top level, in a case or in `checks` are refused with a JSON-pointer error (they were ignored before). `agon_validate_suite` reports these in `errors` instead of failing.
- Several responses with the same `case_id` are now trials. Before, the last one silently replaced the others.
- Tool inputs reject unknown arguments.
- `eval-results.json` gains `rubric` and `gate` keys and `compare.stats`; the Markdown report gains statistics, gate, tag and rubric sections.

### Hardening (review pass)

- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

## 0.1.0

- First release.
