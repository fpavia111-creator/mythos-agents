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

## Install

```bash
npm install -g soteria-of-refunds
soteria-of-refunds demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add soteria-of-refunds -- npx -y soteria-of-refunds@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "soteria-of-refunds": { "command": "npx", "args": ["-y", "soteria-of-refunds@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `soteria_triage` | **allow** | Triage every request against the policy |
| `soteria_explain` | **allow** | Explain one request's flags |
| `soteria_write_queue` | **allow** | Write `refund-queue.csv` + dispute evidence drafts to `mythos-out/soteria` |
| `soteria_request_refund` | **ask · one-click** | After a named human approves, record a refund for a person to issue |
| `payments_issue_refund` | **block** | Listed so agents see the refusal. Soteria never moves money. |
| `payments_submit_dispute` | **block** | Listed so agents see the refusal. A person submits evidence. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

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
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/soteria-of-refunds>
