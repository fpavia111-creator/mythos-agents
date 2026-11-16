# Changelog

## 0.2.0 (2026-11-15)

Added (handoff ver 6)
- Receipts in yen and won (no decimals), yuan, reais and euros: total, subtotal, tax and tip labels in nine languages; dates such as 2026年11月14日, 令和8年11月14日, 2026년 11월 14일 and 14 novembre 2026; d/m/yyyy when the currency is not USD or CAD; merchant lines in any script.

Fixed
- "Sous-total" and "Sub-total" were counted as totals.

- Real exports: Reads Ramp transaction exports (layout checked against Ramp's documentation on 2026-11-15) and the Expensify default CSV directly. New policy field `category_aliases` maps a card or expense system's category names onto policy categories. Staging a reimbursement from a company card export is refused (the company already paid). Table inputs also accept TSV and Excel `.xlsx`; `inspect <file>` and `mythos-sources.json` help when columns differ.
- New `praxidike_read_receipts`: normalises receipt text (US, European decimal comma, month-name dates, "amount due", "grand total") into merchant, total, date, currency, tax, tip and a content hash. Receipt text is still never returned. No OCR.
- Per diem by location and date (`per_diem.rates` with a `"*"` fallback, categories with `per_diem: "meals"` and `per: "day"`, a `days` and `location` column) and dated mileage rates (`mileage_rates`).
- New `praxidike_find_duplicates`: possible duplicates within the export and against earlier reports (`history`) by receipt file, receipt content hash, same merchant/total/date on two receipts, and fuzzy amount/date/merchant match. Scored with reasons.
- New `praxidike_audit_queue`: reports in review order with an explainable score; weights can be set in the policy (`risk_weights`).
- New `praxidike_write_evidence_pack`: self-contained HTML, `audit-queue.csv` and a hashed `evidence-manifest.json`; the manifest hash is recorded in the audit log as `output_sha256`.
- The policy file is validated against a JSON Schema (`validate-config policy <file>`); unknown keys, wrong types and a missing `source` fail with JSON pointers.
- New MCP prompt `review_expense_reports`.
- Receipt amount checks now also read decimal-comma and "amount due"/"grand total" receipts. Results for the 0.1.0 fixtures are unchanged.
- Line results carry two new fields, `days` and `location`.
- Unchanged: reimbursing (`move_money`) is one human click even in Auto; paying and ledger posting stay blocked.

Hardening (review pass)

- A misspelled argument such as `receipt` for `receipts` is now refused with the right name instead of running without receipt checks.
- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

Speed (ver 4)

- Duplicate expenses: only pairs that share a receipt file, receipt text, receipt total and date, or an employee with close amounts and dates are scored. Same pairs as before (checked on 300 random cases). 1,000 lines: 13 s to well under 1 s; 10,000 lines no longer time out.

- A receipt shared by more than 200 lines is listed once under `not_paired` instead of producing every pair (10,000 lines sharing receipts used to run out of memory); those lines are still checked for fuzzy duplicates. Fuzzy candidates are found by date order within each employee.