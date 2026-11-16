# Changelog

## 0.2.0 (2026-11-15)

- Real exports: Reads NetSuite inventory searches and Shopify inventory exports directly; count sheets map common scanner column names. Shopify exports carry no unit cost, so variance values are reported as unknown. Table inputs also accept TSV and Excel `.xlsx`; `inspect <file>` and `mythos-sources.json` help when columns differ.
- Lot and serial tracking: counts, on-hand and movements are matched per `lot` (or `serial`); variance per lot; `lot_mixup` when per-lot variances at one item and location net to zero; `serial_qty_over_one` when a serial is counted more than once (always investigate).
- Unit-of-measure table (`uom_table`): counts in another unit are converted with the stated factor (`uom_converted`), and case-vs-each errors are explained with your factor and the arithmetic. A mismatch with no factor stays `uom_mismatch`.
- New `hesperides_count_plan`: ABC classes by value and a count schedule so A items are counted most often; blind count sheets (`count-plan.csv`), `abc-classes.csv` and `count-plan.ics`.
- New `hesperides_accuracy`: record and value accuracy overall and by location, counter and ABC class (class tolerances), with change since a previous count.
- `hesperides_write_report` also writes `recount-sheet.csv` (blind, no system quantities).
- Config schemas `uom_table` and `count_policy` (`validate-config <schema> <file>`).
- New MCP prompt `cycle_count_review`.
- Changed: `variances.csv`, `adjustments-draft.csv` and `post-requests.csv` have a new `lot` column; reason codes for lot lines are keyed `SKU@LOCATION#LOT`; the `reasons` argument must map to strings. Results for the 0.1.0 fixtures are unchanged.
- Unchanged: posting (`move_money`) is one human click even in Auto; writing to an ERP stays blocked.

Hardening (review pass)

- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

