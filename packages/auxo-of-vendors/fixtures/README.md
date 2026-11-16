Fictional vendors, addresses and payments (example domains). The TINs are invalid placeholders, not real numbers; Auxo's TIN pattern rules flag them on purpose.

- `vendors.csv`, `payments.csv`: the base sample.
- `vendors-merged.csv`, `payments-merged.csv`: the base sample plus a duplicate record sharing a TIN (V10), a near-duplicate whose payments split under the threshold (V11), a second non-US vendor with an expired W-8 (V12) and a payment to a payee with no vendor record (V99).
