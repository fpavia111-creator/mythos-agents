# Ananke of Match (`ananke-of-match`)

> Investigate AP three-way-match exceptions from PO, receipt and invoice exports. Clearing an invoice for posting is one human click; it never posts or pays.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Ananke three exports (CSV/JSON; column names matched loosely): PO lines (`po, line, item, vendor, qty, unit_price`), receipts (`po, line, qty, date`) and invoice lines (`invoice, vendor, po, line, qty, unit_price, date`). For each invoice line it reports:
- no PO, or a PO line that does not exist;
- vendor name different from the PO;
- nothing received; billed more than received (counting earlier invoices on the same line); billed more than ordered;
- unit price outside tolerance (default 2%, plus an optional absolute amount);
- possible duplicate invoices (same vendor, number and line);
- notes that do not block: partial receipt, invoice dated before receipt; and blank quantity or price.

Each exception gets an estimated $ impact, a plain explanation and a suggested next step. The worklist has blank `owner`, `resolution` and `resolved_date` columns.

## Install

```bash
npm install -g ananke-of-match
ananke-of-match demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add ananke-of-match -- npx -y ananke-of-match@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "ananke-of-match": { "command": "npx", "args": ["-y", "ananke-of-match@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `ananke_match` | **allow** | Three-way match with tolerances and $ impact |
| `ananke_explain_exception` | **allow** | Explain one invoice: why it matters, next step |
| `ananke_write_worklist` | **allow** | Write `ap-exceptions.csv` + `ap-match.json` to `mythos-out/ananke` |
| `ananke_request_posting` | **ask · one-click** | After a named human approves, record that an invoice is cleared for posting |
| `erp_post_invoice` | **block** | Listed so agents see the refusal. Ananke never writes to an ERP. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `ananke-of-match approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`ananke-of-match kill`).

Clearing an invoice for payment is `move_money`: it stays **one-click even in Auto**, and `--auto ananke_request_posting` is refused. Auto still runs matching and worklists without stopping. Posting to an ERP stays **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
ananke-of-match tools
ananke-of-match call ananke_match '{"pos":"pos.csv","receipts":"receipts.csv","invoices":"invoices.csv","price_pct":2}'
ananke-of-match eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not an AP automation suite or ERP. It does not approve, post or pay invoices; AP does that in the ERP.
- $ impact is an estimate of the amount at issue, not a recovery figure.
- Matching relies on PO and line numbers in your exports. It does not read invoice PDFs.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/ananke-of-match>
