Fictional sample books. Company names are made up and marked "(fictional)". No customer data.

| File | What it is |
|---|---|
| `source-open-invoices.csv`, `netsuite-sandbox-open-invoices.csv` | Open invoices in the old system and in a sandbox trial load (one missing, one amount differs) |
| `source-trial-balance.csv`, `netsuite-sandbox-trial-balance.csv` | Single-entity trial balances (one blank balance, one difference) |
| `source-tb-multi.csv`, `netsuite-sandbox-tb-multi.csv` | Two fictional subsidiaries (US01 in USD, DE01 in EUR); DE01 differs by 100 EUR, US01 by 0.50 USD |
| `migration-rules.json` | Sample `migration_rules` config: tolerance 0.01, subsidiary/currency columns, a made-up EUR rate, field rules |
| `bad-invoices.csv` | Export with deliberate field-rule problems (duplicate key, bad date, negative amount, unknown currency) |
| `runs/trial-load-1-findings.json`, `runs/trial-load-2-findings.json` | `findings.json` from two earlier fictional trial loads, for `olympus_compare_runs` |

The FX rate in `migration-rules.json` is made up for the sample. Olympus never looks rates up.
