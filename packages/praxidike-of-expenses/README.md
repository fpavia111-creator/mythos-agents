# Praxidike of Expenses (`praxidike-of-expenses`)

> Compares expense reports and receipts to your written policy, cites the policy section for every finding and recommends approve or reject. Reimbursing is one human click; paying is blocked.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Praxidike an expense export (`report_id, line_id, employee, date, submitted_on, category, merchant, amount, currency, receipt, purpose, attendees, nights, miles, preapproved_by`), your policy written as JSON rules with a `source` naming the policy document and its sections, and optionally a folder of receipts. For each line it checks:
- receipts required over your threshold, receipt files that are missing, and text receipts whose total or date does not match the line;
- limits per item, per person (meals, with attendees required) or per night (lodging), and mileage against your rate;
- disallowed and unknown categories, missing business purpose, pre-approval over your amount, late submission, other currencies;
- possible duplicates (same employee, merchant, amount and date) and receipts attached twice.

Every finding names the policy section it comes from. Lines are approve, approve capped (paid up to the limit), needs info or reject; each report gets a recommendation and a recommended amount. Receipt text is read for totals and dates only and never returned, and card-like numbers in purposes are masked. With approval it pre-stages a reimbursement batch (`staged-reimbursements.csv` and `batch.json`) for the reports a person can approve.

## Install

```bash
npm install -g praxidike-of-expenses
praxidike-of-expenses demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add praxidike-of-expenses -- npx -y praxidike-of-expenses@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "praxidike-of-expenses": { "command": "npx", "args": ["-y", "praxidike-of-expenses@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `praxidike_review` | **allow** | Findings per line with policy sections; recommendation and amount per report |
| `praxidike_write_report` | **allow** | Write `expense-review.md` and `line-findings.csv` to `mythos-out/praxidike` |
| `praxidike_stage_reimbursement` | **ask (Auto-eligible)** | Pre-stage `staged-reimbursements.csv` + `batch.json` (nothing paid) |
| `praxidike_request_reimbursement` | **ask · one-click** | After a named human approves, record the batch (bound to its hash) for whoever pays |
| `pay_reimbursement` | **block** | Listed so agents see the refusal. Praxidike never pays. |
| `ledger_post_expense` | **block** | Listed so agents see the refusal. Praxidike never posts to a ledger. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `praxidike-of-expenses approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`praxidike-of-expenses kill`).

`praxidike_stage_reimbursement` can go on Auto, so Auto only pre-stages. Reimbursing is `move_money`: it stays **one-click even in Auto**, and `--auto praxidike_request_reimbursement` is refused. The approval is tied to the batch hash and the staged CSV is re-hashed first. Paying and posting stay **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
praxidike-of-expenses tools
praxidike-of-expenses call praxidike_review '{"expenses":"expenses.csv","policy":"policy.json","receipts":"receipts"}'
praxidike-of-expenses eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not fraud detection. A possible duplicate is a question for a person, not a finding of wrongdoing.
- It applies the rules you write down. It does not read your policy document for you, and it is not tax or legal advice.
- Not an expense platform or card program. It reads exports and receipts you give it and pays no one.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/praxidike-of-expenses>
