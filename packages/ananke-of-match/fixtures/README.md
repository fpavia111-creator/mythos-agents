Fictional POs, receipts, invoices and vendors for demos and tests. No real companies or people.

- `pos.csv`, `receipts.csv`, `invoices.csv`: the main set (duplicates, price variance, over-billing, no PO, missing line).
- `partial-pos.csv`, `partial-receipts.csv`, `partial-invoices.csv`: one PO line with two receipts billed by three invoices (FIFO receipt allocation), a near-duplicate invoice number (`INV3003` vs `INV-3003`) and a partly received line that leaves a GRNI amount.
- `tolerances.json`: a per-vendor tolerance profile (schema `tolerances`). The Globex entry allows 10% price variance, which clears INV-2003.
