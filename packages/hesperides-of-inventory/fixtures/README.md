Fictional items, bins, lots, serials, counts and costs for a made-up wholesaler. Not from any real ERP.

- `counts.csv`, `on-hand.csv`, `transactions.csv`: the main variance sample.
- `counts-prev.csv`: an earlier count of the same items, for the accuracy change.
- `counts-lots.csv`, `on-hand-lots.csv`: lots (a lot mix-up that nets to zero), serials (a swapped serial, one counted twice) and two unit-of-measure cases.
- `uom-table.json`: conversion factors (case = 12 or 10 each, pack = 6 each).
- `count-policy.json`: ABC classes, counts per year, class tolerances and a 26-week plan from 2027-01-04.
- `bad-uom-table.json`: a conversion table with a misspelt key, used by the config-validation eval.
