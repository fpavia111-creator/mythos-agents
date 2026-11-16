# Changelog

## 0.2.0 (2026-11-15)

Fixed (handoff ver 6)
- Calendar ids for apps named in non-Latin scripts could collide; they keep the name's script now.

- Real exports: Reads Microsoft 365 active user detail, Google Workspace, GitHub Copilot seat and Atlassian user exports, and BambooHR or Google Workspace rosters, directly. When an export has no last-activity column, `last_active` is empty and the flag `last_active_not_in_export` replaces an inactivity finding. Table inputs also accept TSV and Excel `.xlsx`; `inspect <file>` and `mythos-sources.json` help when columns differ.
### Added
- Renewal-aware savings: contract terms per app (`helios-policy.json` or a contracts CSV) give act-by dates (renewal minus notice days), `est_saving_next_12m` pro-rated by day from the next renewal you can still give notice for, `notice_window_passed` and `contract_minimum_N` flags, recommended seats at renewal, and an "Act first" list in deadline order.
- Per-app `idle_days` and `downgrade_ratio` overrides.
- `helios_renewal_calendar`: `renewals.ics` with notice-due and renewal events and reminders (deterministic).
- `helios_draft_confirmations`: one Markdown confirmation draft per app owner (roster managers in Cc) and `drafts-index.csv`. Drafts only; nothing is sent.
- `helios_compare_reviews`: period-over-period comparison of two exports.
- `helios_write_review` also writes `renewal-actions.csv`; report tools record `output_sha256` in the audit log.
- Config schema `helios-policy` (also `validate-config`), MCP prompt `helios_seat_review`.

### Changed
- `seat-review.csv` has two new columns, `act_by` and `est_saving_next_12m`, before the reviewer columns.
- Read and report tools reject unknown arguments; `idle_days` must be a whole number and `as_of` a YYYY-MM-DD date.
- Every result now carries `est_saving_next_12m`; without contract terms it assumes savings start at `as_of` and says so.

### Not in this release
- Live SaaS admin connectors (Google Workspace, Slack, GitHub): they depend on the shared connector layer.

### Hardening (review pass)

- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

## 0.1.0

- First release.
