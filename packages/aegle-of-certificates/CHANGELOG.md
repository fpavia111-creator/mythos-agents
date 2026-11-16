# Changelog

## 0.2.0 (2026-11-15)

Fixed (handoff ver 6)
- Chase drafts for vendors named in Japanese, Chinese or Korean all went to `vendor.md`, each overwriting the last; file names now keep the name's script and same-named files are numbered.

- Real exports: Reads `aws acm list-certificates` JSON (ids from the ARN, key from KeyAlgorithm, auto-renew only for Amazon-issued certificates eligible for renewal, epoch timestamps from AWS CLI v1) and crt.sh JSON (latest certificate per name; a CT log shows what was issued, not what is installed). COI trackers map common column names. Table inputs also accept TSV and Excel `.xlsx`; `inspect <file>` and `mythos-sources.json` help when columns differ.
Added
- `aegle_tls_live_check`: opt-in live TLS expiry check (one read-only handshake per listed host, at most 25). Reports expiry, chain trust, hostname match, self-signed and key; compares with the inventory (`inventory_mismatch`, `not_in_inventory`); writes `live-tls.csv`. Policy `ask`, blocked in review mode, MCP `openWorldHint`. Tested with an injected transport and a local TLS server only.
- `aegle_extract_coi`: best-effort COI field extraction from ACORD 25-style certificate text (insured, coverages, limits, dates, additional insured, waiver of subrogation) into `coi-extracted.csv`; every row `needs_review` with its source line and warnings.
- `aegle_diff_inventory`: change list between two inventory snapshots, riskiest first.
- COI requirement profiles as JSON (default, per-category, vendor→category), checked against the `coi_requirements` config schema (`validate-config coi_requirements <file>`). Waiver of subrogation checks.
- `aegle_write_report` also writes `expiry-report.html` (self-contained, CSP, no scripts) and returns `output_sha256`, which the runtime writes into the audit line.
- Calendar file built with core `toIcs`: validated, deterministic, reminders at warn/critical/1 day before or `reminder_days`.
- MCP prompt `aegle_renewal_review`.
- Tighter input schemas (`as_of` pattern, non-negative thresholds).

Changed
- `renewals.ics` now carries three reminders per event by default (was one at 30 days) and adds CALSCALE/METHOD/X-WR-CALNAME lines.
- COI result rows carry `requirement_set`.

Unchanged
- One-click categories, blocked tools and every 0.1.0 test and eval.

Hardening (review pass)

- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

## 0.1.0

First release.
