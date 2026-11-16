Sample, fictional SuiteScript files for demos and tests. Not from any customer account.

| Path | What it is |
|---|---|
| `FileCabinet/SuiteScripts/` | Five scripts: two 1.0, one 2.0, one 2.x, one 2.1 |
| `deps/SuiteScripts/` | A small project for the dependency graph: `ue_order.js` (2.1) uses `lib/pricing.js` and `/SuiteScripts/lib/audit_log.js`; `lib/pricing.js` and `lib/tax.js` import each other (a deliberate cycle); `sl_legacy_report.js` (1.0) requires a missing helper and has `nlapi` text in strings |
| `baseline/inventory.csv` | An earlier, made-up inventory of `FileCabinet/` for `epimetheus_progress` (includes a file that has since been removed) |
| `estimate-config.json` | Sample `estimate_config` effort weights |
