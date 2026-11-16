# Ananke of Match (`ananke-of-match`)

> Investigate AP three-way-match exceptions from PO, receipt and invoice exports. Clearing an invoice for posting is one human click; it never posts or pays.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Ananke three exports (CSV/JSON; column names matched loosely): PO lines (`po, line, item, vendor, qty, unit_price`), receipts (`po, line, qty, date`) and invoice lines (`invoice, vendor, po, line, qty, unit_price, date`). For each invoice line it reports:
- no PO, or a PO line that does not exist;
- vendor name different from the PO;
- nothing received; billed more than received (counting earlier invoices on the same line); billed more than ordered;
- unit price outside tolerance (default 2%, plus an optional absolute amount), optionally per vendor from a tolerance profile;
- possible duplicate invoices (same vendor, number and line) and near-duplicates (same vendor, PO line and amount with an invoice number that differs only in punctuation or leading zeros, or by one character on the same date);
- notes that do not block: partial receipt, invoice dated before receipt; and blank quantity or price.

Each exception gets an estimated $ impact, a plain explanation and a suggested next step. The worklist has blank `owner`, `resolution` and `resolved_date` columns.

**Partial receipts and several invoices per PO line.** Billing is counted cumulatively per PO line and each invoice is allocated to receipts first-in, first-out, so every invoice line lists the receipt(s) (`receipts`) it was matched against. Exact and near-duplicates are not counted as billing.

**PO line status and GRNI.** `ananke_po_status` shows ordered, received and billed quantities per PO line, what is left to receive, received-not-billed (a GRNI accrual estimate at PO price) and billed-not-received.

**Tolerance profiles.** Pass `tolerance_profile` (a JSON file under `--root`) to set tolerances per vendor. Order of precedence: the vendor's entry, then the run's arguments (`price_pct`, `price_abs`, `qty_tolerance`), then the profile's `default`, then the built-in defaults. Each invoice line reports the tolerance it used and where it came from. Check a profile before use:

```bash
ananke-of-match validate-config tolerances tolerances.json
```

```json
{ "default": { "price_pct": 2 },
  "vendors": { "Globex Furniture (fictional)": { "price_pct": 10, "note": "freight surcharge" } } }
```

Unknown keys, wrong types and a missing `vendors` object fail with JSON-pointer errors.

**Vendor scorecard and HTML report.** `ananke_match` returns `by_vendor` (lines, exception rate, $ at issue, top codes). `ananke_write_report` writes `ap-report.html` (self-contained, no scripts or network) and `ap-po-status.csv`; the HTML's sha256 is returned as `output_sha256` and recorded in the audit line (signed when the audit log is signed).

<!-- sources:start -->
## Exports it reads

Table inputs can be CSV, TSV, semicolon- or pipe-separated text, Excel `.xlsx`, JSON or JSONL. A file already in this agent's own columns is read as it is. The exports below are recognised by their column names and mapped onto those columns; dates become `YYYY-MM-DD`, amounts plain decimals (both decimal marks), and yes/no columns `yes`/`no`. Each result lists, under `sources`, which export was recognised, which columns were mapped, and any rows skipped or dates that could be read two ways.

**Purchase order lines** (argument `pos`)

| System | Export | Layout checked against vendor docs |
|---|---|---|
| NetSuite | Transaction saved search (default column labels) | no |

**Goods receipt lines** (argument `receipts`)

| System | Export | Layout checked against vendor docs |
|---|---|---|
| NetSuite | Transaction saved search (default column labels) | no |

**Vendor invoice (bill) lines** (argument `invoices`)

| System | Export | Layout checked against vendor docs |
|---|---|---|
| NetSuite | Transaction saved search (default column labels) | no |
| Xero | Bills > Export (CSV) | no |

Columns named differently? Run `npx ananke-of-match inspect <file>` to see how a file is read (column names and shapes only, never values), then name your columns in `mythos-sources.json` in the root:

```json
{ "files": { "exports/users.csv": { "columns": { "email": "Work E-mail" }, "date_order": "dmy" } } }
```

Where a layout says "checked", its column names were compared with the vendor's documentation on that date. The other layouts were written from knowledge of the export and were not checked. None was tested against a live account. If a real export does not match, the result says which columns were missing; please report it.
<!-- sources:end -->

## Install

```bash
npm install -g ananke-of-match
ananke-of-match demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add ananke-of-match -- npx -y ananke-of-match@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "ananke-of-match": { "command": "npx", "args": ["-y", "ananke-of-match@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `ananke_match` | **allow** | Three-way match with tolerances and $ impact |
| `ananke_explain_exception` | **allow** | Explain one invoice: why it matters, next step |
| `ananke_write_worklist` | **allow** | Write `ap-exceptions.csv` + `ap-match.json` to `mythos-out/ananke` |
| `ananke_po_status` | **allow** | PO line status: received, billed, GRNI estimate, billed-not-received |
| `ananke_write_report` | **allow** | Write `ap-report.html` + `ap-po-status.csv`; logs the report hash |
| `ananke_request_posting` | **ask · one-click** | After a named human approves, record that an invoice is cleared for posting |
| `erp_post_invoice` | **block** | Listed so agents see the refusal. Ananke never writes to an ERP. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

### MCP prompt

`ap_exception_review` (arguments `pos`, `receipts`, `invoices`, optional `tolerance_profile`) walks a host model through match → explain → PO status → worklist and report, and stops at the human click for posting.

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
- Near-duplicate detection is rule-based and can miss duplicates with different amounts or vendors; it can also flag a legitimate invoice. A person decides.
- GRNI is valued at PO price and is an estimate for review, not an accrual entry.
- No ERP connector: it reads exports only.
- Not accounting advice.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/ananke-of-match>
