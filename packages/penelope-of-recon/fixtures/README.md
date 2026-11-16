Fictional bank statements and GL cash detail for demos and tests. No real banks, accounts, companies or people; the account number is made up.

- `bank-statement.csv`, `gl-cash.csv`: October 2026 bank lines and GL cash detail.
- `bank-statement.camt053.xml`, `bank-statement.bai`, `bank-statement.ofx`: the same seven October bank lines as CAMT.053, BAI2 and OFX 1.x, with opening 10800.26 and closing 12422.88.
- `reconciliation-2026-10.csv`: the October workpaper as written by `penelope_write_workpaper` (prior period for the roll-forward).
- `bank-2026-11.csv`, `gl-cash-2026-11.csv`: November lines. The October deposit in transit clears, check 4103 stays outstanding and check 4106 is new. Balances: bank 16047.88, GL 15452.88.
- `accepted-matches-sample.csv`: two accepted matches (one by reference, one ACH pair) for rule suggestions.
- `match-rules.json`: one accepted match rule (schema `match_rules`).
- `exports/statement-mt940.sta`: a German-style MT940 statement in Windows-1252 (November 2026: one SEPA transfer out with an EREF+ reference, one credit, one reversed credit), opening 12500.00 and closing 15950.00. Fictional bank, account and companies.
