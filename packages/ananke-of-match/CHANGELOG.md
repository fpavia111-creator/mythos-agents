# Changelog

## 0.2.0 (2026-11-15)

Changed (handoff ver 6)
- The same vendor written two ways (ACME, Inc. / Acme Inc; 株式会社架空商事 / 架空商事(株)) is no longer a `vendor_mismatch`.

- Real exports: Reads NetSuite transaction saved searches for purchase orders, receipts and bills, and Xero bills, directly; lines are joined by item code. Table inputs also accept TSV and Excel `.xlsx`; `inspect <file>` and `mythos-sources.json` help when columns differ.
- Partial receipts and several invoices per PO line: invoices are allocated to receipts first-in, first-out and each line lists the receipts it matched (`receipts`).
- Per-vendor tolerance profiles (`tolerance_profile`, config schema `tolerances`, `validate-config tolerances <file>`). Each line reports the tolerance used and its source.
- Near-duplicate invoice detection (`near_duplicate_invoice`): same vendor, PO line and amount with a number that differs only in punctuation or leading zeros, or by one character on the same date.
- New tool `ananke_po_status`: PO line status with a GRNI (received-not-billed) estimate and billed-not-received.
- New tool `ananke_write_report`: self-contained `ap-report.html` and `ap-po-status.csv`; `output_sha256` goes into the audit line. `ananke_write_worklist` also returns `output_sha256`.
- `ananke_match` returns a vendor scorecard (`by_vendor`).
- MCP prompt `ap_exception_review`; tool titles; stricter input schemas (tolerances must be numbers >= 0, posting fields non-empty).
- Unchanged: posting stays one-click (`move_money`) even in Auto; `erp_post_invoice` stays blocked. No ERP connector yet (needs the shared connector work).

Hardening (review pass)

- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

## 0.1.0

- First release: three-way match, explanations, worklist, one-click posting request.
