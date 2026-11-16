Fictional workflow exports and run history. Every secret-looking value is a fake placeholder (FAKE-…) and example.com / example.internal hosts are not real.

- `n8n-orders.json`, `n8n-cleanup.json`: n8n workflows (open webhook, typed-in token, plain HTTP, refund step, delete without a filter, shell command).
- `zapier-export.json`: three Zaps (no trigger, outbound email, typed-in API key).
- `make-blueprint.json`: Make scenario with a router, a PayPal refund and a typed-in API key.
- `power-automate-flow.json`: Power Automate flow definition: HTTP trigger open to anyone, a typed-in API key (the same FAKE value as the Make blueprint, so the dependency map shows it shared), a high-entropy header value, a signed URL, a delete with no condition, an email step, a step whose `runAfter` points at a removed step, and an HTTP call to the n8n "orders-in" webhook (a flow-to-flow call).
- `workato-recipes.json`: two Workato recipes sharing one Stripe account: a webhook-triggered refund with a FAKE GitHub-style token typed into a request header, and a stopped purge recipe with an `if` before the delete, a skipped step holding a FAKE Stripe test key, and a `catch` block.
- `arethusa-policy.json`: example policy: one allowed plain-HTTP host and one suppression with a reason and an expiry date.
- `run-history.csv`: run history for the staleness and failure checks.
