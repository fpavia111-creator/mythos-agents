# Changelog

## 0.2.0 (2026-11-15)

Added (handoff ver 6)
- SWIFT MT940 statements (.sta, .mt940, .940), including the German structured :86: text; the EREF+ end-to-end reference becomes the line's reference.
- Text statements are decoded like other files, so a Windows-1252 MT940 or OFX keeps its accents.
- Ledger debit and credit columns read Soll/Haben, 借方/貸方 and the like.

- Real exports: Bank statements in table form now go through the core reader: TSV and Excel are accepted (`bank_format` gains `tsv` and `xlsx`), and Chase (checking and card), Bank of America (summary block skipped), Wells Fargo (no header row), Capital One 360 (sign from the transaction type), Mercury (failed rows skipped) and Xero statement downloads are recognised. GL detail from NetSuite, QuickBooks Online (Transaction Detail by Account) and Xero (Account Transactions) is recognised, with headings, balances and totals skipped. Table inputs also accept TSV and Excel `.xlsx`; `inspect <file>` and `mythos-sources.json` help when columns differ.
- Bank file formats: CAMT.053 (XML), BAI2 and OFX/QFX through small built-in parsers (no dependencies). Format is detected from the extension, then the content, or set with `bank_format`. The file's closing balance is used for the tie-out when `bank_balance` is left out. Account numbers are masked to the last 4.
- New tool `penelope_read_statement`: show the parsed lines and check opening + lines = closing.
- Learned match rules: `penelope_suggest_rules` (read) proposes rules from accepted matches; `penelope_accept_rule` (ask) records an accepted rule in `match-rules.json` (config schema `match_rules`). Rules apply only when passed as `rules`.
- Month-end roll-forward: `penelope_roll_forward` carries last period's outstanding items in, clears them, ages what is left (stale flag) and ties out.
- Matching: one GL line can now match several bank lines (`group_bank`).
- Workpaper: new `reconciliation.html` with blank sign-off lines, per-file `file_sha256`, and `output_sha256` in the audit line. `reconciliation.csv` gains a `reference` column (after `description`) so the next month's roll-forward can clear checks by number.
- MCP prompt `month_end_bank_rec`; tool titles; stricter input schemas.
- Unchanged: adjusting entries stay one-click (`move_money`) even in Auto; `ledger_post_journal` stays blocked.

Hardening (review pass)

- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.


Speed (ver 4)

- Matching indexes bank and GL lines by day, reference and amount instead of scanning every pair. On generated 10,000-line files, reconcile went from about 40 s to under 1 s, roll-forward from 35 s to under 2 s; results are the same as before (checked on 300 random cases).

## 0.1.0

- First release: proposed matches, reconciling items, tie-out, workpaper, accepted matches, one-click adjusting-entry request.
