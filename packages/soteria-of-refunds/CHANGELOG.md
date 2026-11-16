# Changelog

## 0.2.0

Fixed (handoff ver 6)
- A dispute reason written in German, French, Spanish, Portuguese, Italian, Japanese, Chinese or Korean was always `general`. The reason-text fallback now knows each category in those languages (on folded text, so accents and full-width forms do not matter).
- Network names in other scripts (ビザ, 마스터카드, 美国运通...) were not recognised. JCB and UnionPay are now recognised by name; their reason codes are not in the table, so their disputes are classified from the reason text and say so. The `network` argument of `soteria_reason_code` accepts `jcb` and `unionpay`.

- Real exports: Reads Stripe payments/disputes and Shopify orders exports directly (one row per order for Shopify line-item exports). Table inputs also accept TSV and Excel `.xlsx`; `inspect <file>` and `mythos-sources.json` help when columns differ.
- Card-network reason-code mapping (Visa, Mastercard, Amex, Discover) to dispute categories, with a reason-text fallback and `reason_code_overrides` in the policy. New `soteria_reason_code` lookup tool.
- New `soteria_evidence_pack`: per-dispute evidence checklist that differs by category, items marked on file / missing / attach from your exports, an explained readiness score, earlier undisputed orders 120-365 days back for fraud disputes, a citation for every source row used, `evidence-index.json` (its SHA-256 is written to the audit line as `output_sha256`) and `dispute-deadlines.ics`.
- Triage items and `refund-queue.csv` carry `dispute_category` for chargebacks; requests exports may add `reason_code` and `network` columns.
- The policy file is validated against the `refund_policy` config schema (`validate-config refund_policy <file>`).
- MCP prompt `refund_and_dispute_workflow`.
- Unchanged: refund requests stay one named human click, even in Auto; issuing refunds and submitting disputes stay blocked.
- Not in this release: the Stripe read-only connector (needs the shared connector work).

Hardening (review pass)

- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

Speed (ver 4)

- Evidence packs look up earlier orders by customer from an index built once, instead of scanning every order for every dispute. 10,000 rows: 18 s to about 1 s; same packs.
