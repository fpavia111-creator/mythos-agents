# Changelog

## 0.2.0 (2026-11-15)

Added
- `polyhymnia_variance`: budget-vs-actual variance by line (full budget for final reports or after the period ends, otherwise the share expected by now), `variance_pct` / `variance_amount` thresholds, `[EXPLAIN VARIANCE]` markers, optional `explanation` column carried through but still marked for review, and a spend-down projection (`projected_underspend`, `projected_overspend`).
- Funder template mapping: `funder_template` config schema (`validate-config funder_template <file>`), `polyhymnia_template_check`, and `template` on `polyhymnia_build_packet` (sections in template order, word limits, funder guidance, required attachments, template variance threshold; missing sections and attachments flagged).
- `polyhymnia_calendar`: `grant-deadlines.ics` (core `toIcs`, validated) with report deadlines and grant period ends, reminders 30/14/7/1 days or `reminder_days`; `output_sha256` in the audit line.
- `polyhymnia_evidence_pack` (ask, Auto-eligible): zip of the draft packet, cited evidence, `variance.csv` and a SHA-256 `manifest.json`; `output_sha256` in the audit line.
- Draft packets include a "Budget vs actual variance" section and a checklist item per line that needs an explanation.
- MCP prompt `polyhymnia_report_cycle`. Tighter input schemas.

Unchanged
- `polyhymnia_review` open items and every 0.1.0 test and eval. Submitting stays one-click; `funder_portal_submit` stays blocked.

Hardening (review pass)

- Packet folders and evidence zips are named with `safeFileName(grant_id)`. Before this a grant id of `../../../x` wrote the packet outside `packets/` (still inside `--root`).
- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

Speed (ver 4)

- Budget lines and outcomes are grouped by grant once instead of being filtered for every grant. 10,000 lines: about 31 s to under 1 s; same results.

## 0.1.0

First release.
