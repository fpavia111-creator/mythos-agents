# Soteria of Refunds (`soteria-of-refunds`)

> Triage refund requests and chargebacks against your written policy. Issuing money is blocked; a refund request is one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Soteria a requests export (`request_id, type, order_id, customer, amount, reason, requested_at, returned`), an orders export (`order_id, customer, amount, refunded, order_date, delivered_date, tracking`) and your policy as JSON (`window_days`, `window_from`, `review_over`, `max_refunds_per_customer_90d`, `chargeback_response_days`, `return_required_over`). For each request it flags:
- outside the refund window; more than the refundable balance (order total minus earlier refunds);
- duplicate requests on the same order; repeat requests from one customer within 90 days;
- returns your policy requires but that are not received; amounts above your review threshold;
- missing orders or amounts; not-delivered claims with or without tracking.

It suggests eligible, needs review, deny per policy, hold duplicate, or prepare dispute evidence, and writes a queue with blank decision columns plus an evidence draft for each chargeback (with a respond-by date from your policy).

For chargebacks it also:
- maps the card-network reason code (Visa `13.1`, Mastercard `4853`, Amex `C08`, Discover `UA02` and others; optional `reason_code` and `network` columns) or, without a code, the reason text, to a dispute category: fraud, not received, not as described, duplicate, credit not processed, cancelled recurring, authorization, processing error;
- builds the evidence checklist for that category, marks what your exports already show (order, delivery date, tracking, return, earlier refund, and for fraud two or more earlier undisputed orders from the same customer 120-365 days back) and what a person must attach (AVS/CVV, messages, listing, terms);
- gives a readiness score with its explanation (share of checkable items on file; not a prediction of the outcome);
- writes one self-contained HTML evidence pack per dispute that cites every source row used (file and row number, plus the policy file's SHA-256), an `evidence-index.json` whose hash goes into the audit log line, and `dispute-deadlines.ics` with reminders 3 and 1 days before each respond-by date.

<!-- sources:start -->
## Exports it reads

Table inputs can be CSV, TSV, semicolon- or pipe-separated text, Excel `.xlsx`, JSON or JSONL. A file already in this agent's own columns is read as it is. The exports below are recognised by their column names and mapped onto those columns; dates become `YYYY-MM-DD`, amounts plain decimals (both decimal marks), and yes/no columns `yes`/`no`. Each result lists, under `sources`, which export was recognised, which columns were mapped, and any rows skipped or dates that could be read two ways.

**Refund requests and chargebacks** (argument `requests`)

| System | Export | Layout checked against vendor docs |
|---|---|---|
| Stripe | Payments > Export (CSV) | no |

**Orders** (argument `orders`)

| System | Export | Layout checked against vendor docs |
|---|---|---|
| Shopify | Orders > Export (CSV) | no |
| Stripe | Payments > Export (CSV) | no |

Columns named differently? Run `npx soteria-of-refunds inspect <file>` to see how a file is read (column names and shapes only, never values), then name your columns in `mythos-sources.json` in the root:

```json
{ "files": { "exports/users.csv": { "columns": { "email": "Work E-mail" }, "date_order": "dmy" } } }
```

Where a layout says "checked", its column names were compared with the vendor's documentation on that date. The other layouts were written from knowledge of the export and were not checked. None was tested against a live account. If a real export does not match, the result says which columns were missing; please report it.
<!-- sources:end -->

### Disputes from other markets

When a dispute has no known reason code, Soteria classifies it from the reason text. That text can be in English, German, French, Spanish, Portuguese, Italian, Japanese, Chinese or Korean (`Ware nicht erhalten`, `Cobro duplicado`, `商品が届いていない`, `重复扣款`, `환불되지 않았습니다`...). Network names are read in other scripts too (ビザ, 마스터카드, 美国运通). JCB and UnionPay are recognised by name, but their reason codes are not in Soteria's table, so their disputes are always classified from the text and the result says so. The word lists are short and a person still checks the category.

## Install

```bash
npm install -g soteria-of-refunds
soteria-of-refunds demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add soteria-of-refunds -- npx -y soteria-of-refunds@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "soteria-of-refunds": { "command": "npx", "args": ["-y", "soteria-of-refunds@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `soteria_triage` | **allow** | Triage every request against the policy |
| `soteria_explain` | **allow** | Explain one request's flags |
| `soteria_write_queue` | **allow** | Write `refund-queue.csv` (now with `dispute_category`) + dispute evidence drafts to `mythos-out/soteria` |
| `soteria_reason_code` | **allow** | Look up a reason code or reason text: category, label and evidence checklist |
| `soteria_evidence_pack` | **allow** | Per-dispute HTML evidence packs with row citations, `evidence-index.json`, `dispute-deadlines.ics` |
| `soteria_request_refund` | **ask · one-click** | After a named human approves, record a refund for a person to issue |
| `payments_issue_refund` | **block** | Listed so agents see the refusal. Soteria never moves money. |
| `payments_submit_dispute` | **block** | Listed so agents see the refusal. A person submits evidence. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

### Policy file

The policy JSON is checked against the `refund_policy` schema: unknown keys (a typo such as `reveiw_over`), wrong types and a missing `window_days` fail with a JSON pointer. Check a file with `soteria-of-refunds validate-config refund_policy policy.json`. `reason_code_overrides` maps a code to one of the categories above when your processor uses its own codes.

### MCP prompt

`refund_and_dispute_workflow` walks the host model through triage, explanations, the queue, evidence packs and refund requests (each waits for a named person).

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `soteria-of-refunds approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`soteria-of-refunds kill`).

All triage tools are read or report. A refund is `move_money`: it stays **one-click even in Auto**, and `--auto soteria_request_refund` is refused. Issuing refunds and submitting disputes stay **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
soteria-of-refunds tools
soteria-of-refunds call soteria_triage '{"requests":"requests.csv","orders":"orders.csv","policy":"policy.json"}'
soteria-of-refunds eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not a payments, helpdesk or chargeback-management service. It connects to no processor and moves no money.
- It applies the policy you write. It is not legal or consumer-law advice, and statutory rights can override your policy.
- The respond-by date comes from your setting; your processor's deadline is the one that counts.
- The reason-code map is a working guide built from public summaries, not the card networks' rulebooks, which change. It does not predict whether a dispute will be won.
- No processor connector yet: it reads exports only.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/soteria-of-refunds>
