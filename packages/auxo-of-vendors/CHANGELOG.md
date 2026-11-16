# Changelog

## 0.2.0 (2026-11-15)

Fixed (handoff ver 6)
- Duplicate-vendor checks now compare Japanese, Chinese and Korean names (they normalized to nothing). Request-draft file names keep the vendor's own script.

- Real exports: Reads NetSuite vendor and transaction searches, QuickBooks Online vendor contact list and grouped "transaction list by vendor" report, and Xero contacts directly. Table inputs also accept TSV and Excel `.xlsx`; `inspect <file>` and `mythos-sources.json` help when columns differ.
Added
- TIN pattern rules per entity type: never-assigned EIN prefixes, never-issued SSN areas/groups/serials, ITIN ranges, placeholder numbers, and the wrong kind of number for the entity type (`tin_pattern_invalid`, `tin_type_mismatch`). TINs stay masked everywhere. No IRS TIN matching.
- W-8 tracking for non-US vendors (`w8_received`, `w8_type`, `w8_signed`): `w8_missing`, `w8_unsigned`, `w8_expired`, usual form (W-8BEN / W-8BEN-E) and a W-8 checklist instead of the W-9 one; W-8 request drafts.
- `form_expected` and `checklist` per vendor; tracker columns `form_expected` and `checklist_open`.
- `auxo_1099_readiness` (report): vendors at or over the threshold and what each lacks, non-US vendors over the threshold, card/app-only payees, payments with no vendor record; `1099-readiness.md` and `.csv`, `output_sha256` in the audit line. Not a filing.
- `auxo_find_duplicates` (read): same TIN (never shown), similar names, same address or email; `split_under_threshold`.
- `auxo_write_tracker` returns `output_sha256`.
- MCP prompt `auxo_year_end_readiness`. Tighter input schemas (`year` integer, `as_of` pattern, non-negative numbers).

Changed (deliberate; existing assertions updated)
- The bundled fixture TINs are invalid placeholders by rule, so the new pattern checks flag V1, V4 and V6: on the base fixtures `ready` goes from 2 to 0, `fix_details` from 2 to 4 and `over_threshold_not_ready` from 3 to 5 (6 at a 600 threshold).
- Non-US vendors without a valid W-8 now get a request draft (they stay `ask_preparer`). With the fixture changes above, `auxo_draft_requests` writes 7 drafts instead of 4.

Unchanged
- Sending stays one-click; `irs_efile` and `send_email` stay blocked. Thresholds and card/app handling are as in 0.1.0.

Hardening (review pass)

- Request draft file names are built with `safeFileName`, so a vendor id like `../../x` can no longer place a draft outside `requests/`.
- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.


Speed (ver 4)

- `auxo_find_duplicates` only scores pairs that can match: same TIN or email from an index, and names whose Jaro-Winkler score could reach the threshold (an exact bound on shared characters). Results are the same as comparing every pair (checked on 1,500 random cases). 1,000 vendors: 7.3 s to 0.3 s; 10,000 vendors: over 3 minutes to about 12 s.

## 0.1.0

First release.
