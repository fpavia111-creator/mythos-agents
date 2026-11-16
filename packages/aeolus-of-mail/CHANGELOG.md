# Changelog

## 0.2.0

- **BIMI check** in `aeolus_audit`: record syntax, an `https://` SVG logo URL, a `.pem` certificate URL, and DMARC enforcement at `pct=100`. New option `bimi_selector`. No BIMI record is not a finding.
- **`aeolus_dmarc_reports`** (allow): reads saved DMARC aggregate reports (`.xml`, `.xml.gz`, `.gz`, `.zip`, or folders) offline. Pass/fail by source IP, SPF and DKIM alignment, a reason and fix for each failing source, duplicate reports counted once, and a readiness verdict.
- **`aeolus_check_headers`** (allow): reads a saved `.eml` offline. Receiver results, Return-Path and DKIM alignment, `rsa-sha1`, DKIM selectors in use, and ARC chain structure (instances, complete sets, `cv=` values). Signatures are not verified.
- **`aeolus_plan_dmarc_rollout`** (ask, Auto-eligible): staged plan `none` → `quarantine` → `reject` with dates, an `.ics` calendar with reminders, and a proposal for the next stage only. Never skips straight to `reject`; the next enforcing stage keeps a `[TO CONFIRM]` marker unless the reports meet the threshold. Applying it is still the one-click `aeolus_request_dns_change`.
- **`dmarc_rollout` config schema**: `aeolus-of-mail validate-config dmarc_rollout <file>`; typos fail with JSON-pointer errors.
- `aeolus_write_report` also writes a self-contained HTML report, `dmarc-sources.csv` when given reports, and returns `output_sha256` (recorded in the audit log).
- MCP prompt `mail_dns_review` for the end-to-end workflow.
- `aeolus_draft_records` wording now points to the report and rollout tools; it still never proposes enforcement.

Hardening (review pass)

- `output_sha256` for Markdown reports is the hash of the file as written.
- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

