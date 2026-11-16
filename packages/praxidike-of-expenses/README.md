# Praxidike of Expenses (`praxidike-of-expenses`)

> Compares expense reports and receipts to your written policy, cites the policy section for every finding and recommends approve or reject. Reimbursing is one human click; paying is blocked.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Praxidike an expense export (`report_id, line_id, employee, date, submitted_on, category, merchant, amount, currency, receipt, purpose, attendees, nights, miles, preapproved_by`), your policy written as JSON rules with a `source` naming the policy document and its sections, and optionally a folder of receipts. For each line it checks:
- receipts required over your threshold, receipt files that are missing, and text receipts whose total or date does not match the line;
- limits per item, per person (meals, with attendees required), per night (lodging) or per day, per-diem rates by location and date (exact location first, then a `"*"` row), and mileage against your rate or a dated rate table (`mileage_rates`);
- disallowed and unknown categories, missing business purpose, pre-approval over your amount, late submission, other currencies;
- possible duplicates (same employee, merchant, amount and date) and receipts attached twice.

Every finding names the policy section it comes from. Lines are approve, approve capped (paid up to the limit), needs info or reject; each report gets a recommendation and a recommended amount. Receipt text is read for totals and dates only and never returned, and card-like numbers in purposes are masked. It also:
- normalises receipt text you already have (US, European decimal comma, month-name dates, "amount due" and "grand total" styles) into merchant, total, date, currency, tax and tip. It does no OCR; give it text from your own scanner;
- finds possible duplicate claims within the export and against earlier reports (`history`): the same receipt file, identical receipt text under another file name, two receipts with the same merchant, total and date, and fuzzy matches (same employee, similar merchant, amount within 1%, dates within 3 days by default). Each pair has a score and reasons;
- ranks reports in the order a reviewer should look at them. The score adds stated weights per finding (override them with `risk_weights` in the policy), duplicates against earlier reports and the amount claimed, and every point has its reason;
- writes an evidence pack: `evidence-pack.html` (self-contained, no scripts), `audit-queue.csv` and `evidence-manifest.json` with the sha256 of every input and output. The manifest hash goes into the audit log as `output_sha256`.

With approval it pre-stages a reimbursement batch (`staged-reimbursements.csv` and `batch.json`) for the reports a person can approve.

<!-- sources:start -->
## Exports it reads

Table inputs can be CSV, TSV, semicolon- or pipe-separated text, Excel `.xlsx`, JSON or JSONL. A file already in this agent's own columns is read as it is. The exports below are recognised by their column names and mapped onto those columns; dates become `YYYY-MM-DD`, amounts plain decimals (both decimal marks), and yes/no columns `yes`/`no`. Each result lists, under `sources`, which export was recognised, which columns were mapped, and any rows skipped or dates that could be read two ways.

**Expense lines** (arguments `expenses`, `history`)

| System | Export | Layout checked against vendor docs |
|---|---|---|
| Ramp | Transactions > Export (CSV) | support.ramp.com "Exporting your data to CSV" on 2026-11-15 |
| Expensify | Default CSV export of expenses | no |

Columns named differently? Run `npx praxidike-of-expenses inspect <file>` to see how a file is read (column names and shapes only, never values), then name your columns in `mythos-sources.json` in the root:

```json
{ "files": { "exports/users.csv": { "columns": { "email": "Work E-mail" }, "date_order": "dmy" } } }
```

Where a layout says "checked", its column names were compared with the vendor's documentation on that date. The other layouts were written from knowledge of the export and were not checked. None was tested against a live account. If a real export does not match, the result says which columns were missing; please report it.
<!-- sources:end -->

### Receipts from other markets

Receipt text in yen and won (no decimals), yuan, reais and euros is read: totals under `合計`, `合计`, `합계`, `Total TTC`, `Zu zahlen`, `Total a pagar` or `Totale`; subtotal, tax and tip labels in nine languages; dates such as `2026年11月14日`, `令和8年11月14日`, `2026년 11월 14일` and `14 novembre 2026`; `03/11/2026` read day first when the receipt is not in US or Canadian dollars. Cash handed over (`お預り`) and item counts (`3点`) are never taken as the total. Praxidike still does no OCR and says nothing about any country's tax rules.

## Install

```bash
npm install -g praxidike-of-expenses
praxidike-of-expenses demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add praxidike-of-expenses -- npx -y praxidike-of-expenses@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "praxidike-of-expenses": { "command": "npx", "args": ["-y", "praxidike-of-expenses@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `praxidike_review` | **allow** | Findings per line with policy sections; recommendation and amount per report |
| `praxidike_read_receipts` | **allow** | Merchant, total, date, currency, tax, tip and content hash per text receipt (text never returned) |
| `praxidike_find_duplicates` | **allow** | Possible duplicate pairs, also against earlier reports, with scores and reasons |
| `praxidike_audit_queue` | **allow** | Reports in review order with an explainable score |
| `praxidike_write_report` | **allow** | Write `expense-review.md` and `line-findings.csv` to `mythos-out/praxidike` |
| `praxidike_write_evidence_pack` | **allow** | Write `evidence-pack.html`, `audit-queue.csv` and `evidence-manifest.json` (hashed) |
| `praxidike_stage_reimbursement` | **ask (Auto-eligible)** | Pre-stage `staged-reimbursements.csv` + `batch.json` (nothing paid) |
| `praxidike_request_reimbursement` | **ask · one-click** | After a named human approves, record the batch (bound to its hash) for whoever pays |
| `pay_reimbursement` | **block** | Listed so agents see the refusal. Praxidike never pays. |
| `ledger_post_expense` | **block** | Listed so agents see the refusal. Praxidike never posts to a ledger. |

Any other tool name is blocked. MCP hosts also get the prompt `review_expense_reports`, which walks a model through the whole review and stops for the human click. `mythos_info` shows the pinned model, mode, caps and every decision.

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
praxidike-of-expenses validate-config policy policy.json   # typos fail with JSON pointers
```

The policy file is checked against a JSON Schema before every run: unknown keys (`"recipt_required_over"`), wrong types and a missing `source` fail with the JSON pointer of the problem.

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not fraud detection. A possible duplicate or a high review score is a question for a person, not a finding of wrongdoing.
- Not OCR. Receipt reading works on text and recognises common layouts; an unusual receipt may give no total or the wrong one, so a person checks.
- Per-diem and mileage rates are the ones you write into the policy. Praxidike ships no official rate tables.
- It applies the rules you write down. It does not read your policy document for you, and it is not tax or legal advice.
- Not an expense platform or card program. It reads exports and receipts you give it and pays no one.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/praxidike-of-expenses>
