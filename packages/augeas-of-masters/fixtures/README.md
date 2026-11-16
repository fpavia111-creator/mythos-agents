Fictional vendors and items for demos and tests. example domains only; no customer data.

- `vendors.csv` — seven vendors: a tax-id duplicate, a spelling duplicate, and a same-name pair with different tax ids.
- `items.csv` — four items: one UPC duplicate and two colour variants that must stay apart.
- `augeas-rules.json` — sample survivorship rules for `augeas_merge_preview` and `augeas_apply_merge`.

The 1,000-row precision/recall file is not stored here: `test/helpers/seeded-vendors.js` generates it in the test from a fixed seed (made-up names, `.example` domains, 555-01xx phones, `00-` tax ids that are never issued).
