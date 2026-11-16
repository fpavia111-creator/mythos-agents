# Changelog

## 0.2.0 — 2026-11-15

Fixed (handoff ver 6)
- Vendor and item names in Japanese, Chinese or Korean normalized to nothing, so their duplicates were never found. Names keep every script, and legal forms such as 株式会社, (株), 有限公司, 주식회사, (주), AG, SARL, S.p.A. and Ltda are dropped.
- Merge previews showed no conflict between two different CJK values.
- Tax ids keep letters after the first digit (Chinese credit codes, codice fiscale, NIE), so two companies differing only there are not joined.
- Mexico's generic RFCs (XAXX010101000 for the general public, XEXX010101000 for foreign parties) and all-same-digit tax ids such as 000000000 made unrelated vendors one cluster. They are no longer used to pair records, and the result says how many records carry one under `not_compared`. A Mexican RFC keeps its leading letters. `isPlaceholderTax` is exported.
- Spanish, Mexican, Brazilian, Italian and European legal forms at the end of a name (S.L., S.L.U., S.A.U., S.A. de C.V., S. de R.L. de C.V., S/A, ME, EPP, S.n.c., SE) were kept, so `Ejemplo S.L.` and `Ejemplo` did not compare as the same name.

Added
- Id, name, tax id, phone, address and status columns are found by their names in eight languages.

### Added
- Better matching: word-by-word Jaro-Winkler (Monge-Elkan) on normalized names, with each word weighted by how rare it is in the file; normalized tax ids / UPCs; normalized postal addresses (same house number required); phone and email-domain support. Each pair now carries explainable `signals`.
- Clusters never contain two different tax ids, even through a record with none (`kept_apart` lists the links that were refused). A similar name with a different address and a different phone is not merged on its own.
- Blocking for files over 400 rows (`compared_pairs`, `blocking` in the result).
- Seeded 1,000-row precision/recall test (generated in the test with a fixed seed; fictional names, `.example` domains, 555-01xx phones, `00-` tax ids): precision 0.986, recall 1.0 at the default threshold; several other seeds ≥ 0.95.
- `augeas_merge_preview`: field-level winners, which record each came from, the rule used, conflicts, and the golden record. Bank and payment columns are never changed.
- `augeas_apply_merge` gains `fill_survivor` (write the previewed winners into the survivor row) and `rules`, and appends every merge to `<copy>.undo.jsonl`. The written copy's hash is logged as `output_sha256`.
- `augeas_undo_merge`: restores the copy byte-for-byte to its state before the last merge (hash-checked; refuses if the copy was edited).
- `augeas-rules` config schema (survivor order, per-field rules, protected fields); `validate-config augeas-rules <file>`.
- `merge-proposals.html`: a self-contained review page (no scripts, no network).
- MCP prompt `augeas_dedupe_master`; `title` on tools; stricter input schemas.

### Changed
- Default `threshold` is now 0.92 on the new name score (was 0.88 on character-bigram Dice). The `dice` and `normName` exports are kept.
- Suggested survivor order can be set in the rules file.
- All existing tests and evals pass unchanged.

### Hardening (review pass)

- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.


Speed (ver 4)

- A tax id or phone shared by more than 500 rows (usually a placeholder such as 000-000-0000) is no longer paired on; the result lists it under `not_compared`. Before, 10,000 rows sharing one phone ran out of memory.
- Clusters collect their pairs through an id index instead of scanning every pair per cluster. 10,000 vendors: about 3 s.
