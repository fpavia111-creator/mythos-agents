Fictional orders, customers (example.com) and refund policy.

- `requests.csv`, `orders.csv`, `policy.json`: refund requests and one chargeback, with the orders they refer to and an example policy.
- `disputes.csv`: six fictional chargebacks with Visa, Mastercard, Amex and Discover reason codes (one with no code) for the reason-code mapping and evidence packs. `orders.csv` also holds their orders, including two earlier orders for one customer to show the prior-undisputed-orders check.
- `policy-typo.json`: a deliberately misspelt policy (`reveiw_over`) used by the evals to show schema errors.
