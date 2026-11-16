# Penelope of Recon (`penelope-of-recon`)

> Bank-to-GL reconciliation from CSV, CAMT.053, BAI2 or OFX exports: proposed matches, reconciling items, a tie-out and draft adjusting entries. Posting is one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Penelope a bank statement (CSV/JSON with `date, description, reference, amount` or debit/credit columns, an ISO 20022 **CAMT.053** XML file, a **BAI2** file or an **OFX/QFX** file) and the GL detail for the cash account. It proposes matches in this order:
- same reference and amount (high confidence);
- match rules a person accepted, when you pass the rules file (see below);
- same amount within `date_window` days (default 3), nearest date first; ambiguous cases are marked low confidence;
- one bank line equal to 2–`max_group` GL lines (batched deposits), then one GL line equal to 2–`max_group` bank lines (for example one payroll entry that clears as several debits).

What is left is listed by side: bank fees and interest (with a draft adjusting entry), returned items, and anything else in the bank only; deposits in transit and outstanding payments in the GL only. With both ending balances it ties adjusted bank to adjusted book and shows the difference. The workpaper has blank reviewer columns; proposed entries are marked "not posted". It also writes `reconciliation.html` (self-contained, no scripts) with the tie-out and blank preparer/reviewer sign-off lines; its sha256 is returned as `output_sha256` and recorded in the audit line.

**Bank file formats.** The CAMT.053, BAI2 and OFX readers are small built-in parsers for the common statement fields (booking date, amount and credit/debit, reference, description, opening/closing balance). `penelope_read_statement` shows what was read and checks opening + lines = closing. When you leave out `bank_balance` and give `gl_balance`, the file's closing balance is used. Account numbers are shown masked to the last 4 digits. They are not full implementations of these standards: multi-currency statements, BAI2 batch detail (`D` funds) beyond the basics and OFX investment statements are not handled.

**Learned match rules.** After a person accepts matches (`accepted-matches.csv`), `penelope_suggest_rules` proposes rules such as *bank lines with "ach acme supply" match a GL line with "acme supply bill pay", same amount, money out, up to 1 day apart*. Digits are ignored so the rule survives changing invoice numbers. Nothing changes until a person accepts a rule with `penelope_accept_rule` (an approval), which writes `match-rules.json`; rules are applied only when that file is passed as `rules`. Check a rules file with `penelope-of-recon validate-config match_rules match-rules.json`.

**Month-end roll-forward.** `penelope_roll_forward` takes last period's `reconciliation.csv` and this period's bank and GL files. Outstanding checks and deposits in transit are carried in, cleared against this period's bank lines (same amount, a matching reference wins, a different check number never clears), and the rest stay open with their age; items older than `stale_days` (default 60) are flagged. It shows opening − cleared + new = closing outstanding and, with both balances, the adjusted-balance tie-out. Last period's bank-only items are listed so you can confirm an entry was posted.

<!-- sources:start -->
## Exports it reads

Table inputs can be CSV, TSV, semicolon- or pipe-separated text, Excel `.xlsx`, JSON or JSONL. A file already in this agent's own columns is read as it is. The exports below are recognised by their column names and mapped onto those columns; dates become `YYYY-MM-DD`, amounts plain decimals (both decimal marks), and yes/no columns `yes`/`no`. Each result lists, under `sources`, which export was recognised, which columns were mapped, and any rows skipped or dates that could be read two ways.

**Bank statement (table files)** (argument `bank`)

| System | Export | Layout checked against vendor docs |
|---|---|---|
| Chase | Checking or savings account activity (CSV) | no |
| Chase | Credit card activity (CSV) | no |
| Bank of America | Checking account activity (CSV, with its summary block) | no |
| Wells Fargo | Account activity download (CSV with no header row) | no |
| Capital One | 360 account transactions (CSV) | no |
| Mercury | Transactions export (CSV) | no |
| Xero | Bank statement CSV (Xero import layout) | no |

**GL cash-account detail** (argument `gl`)

| System | Export | Layout checked against vendor docs |
|---|---|---|
| NetSuite | Transaction saved search (default column labels) | no |
| QuickBooks Online | Transaction Detail by Account / General Ledger report | no |
| Xero | Account Transactions report (Excel or CSV) | no |

Columns named differently? Run `npx penelope-of-recon inspect <file>` to see how a file is read (column names and shapes only, never values), then name your columns in `mythos-sources.json` in the root:

```json
{ "files": { "exports/users.csv": { "columns": { "email": "Work E-mail" }, "date_order": "dmy" } } }
```

Where a layout says "checked", its column names were compared with the vendor's documentation on that date. The other layouts were written from knowledge of the export and were not checked. None was tested against a live account. If a real export does not match, the result says which columns were missing; please report it.
<!-- sources:end -->

### MT940 and statements from other markets

Besides CSV, Excel, CAMT.053, BAI2 and OFX, Penelope reads SWIFT MT940 statements (`.sta`, `.mt940`, `.940`), as German and other European banks send them: balances, reversals and the structured `:86:` text, with the SEPA end-to-end reference (`EREF+`) used as the line's reference. Statement files in Windows-1252 keep their accents. GL exports with `Soll`/`Haben`, `借方`/`貸方` or `차변`/`대변` columns and amounts such as `1.250,00` are read as ledger debits and credits. Japanese Zengin and other national bank formats are not read yet; export CSV from the bank instead.

## Install

```bash
npm install -g penelope-of-recon
penelope-of-recon demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add penelope-of-recon -- npx -y penelope-of-recon@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "penelope-of-recon": { "command": "npx", "args": ["-y", "penelope-of-recon@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `penelope_reconcile` | **allow** | Propose matches, list reconciling items, tie balances |
| `penelope_read_statement` | **allow** | Parse a bank file (CSV/JSON, CAMT.053, BAI2, OFX) and check its balances |
| `penelope_write_workpaper` | **allow** | Write `reconciliation.csv`, `reconciliation.md`, `reconciliation.html`, `proposed-entries.csv` to `mythos-out/penelope` |
| `penelope_roll_forward` | **allow** | Carry last period's outstanding items forward, age them and tie out |
| `penelope_suggest_rules` | **allow** | Suggest match rules from accepted matches |
| `penelope_accept_rule` | **ask (Auto-eligible)** | Record a rule a person accepted in `match-rules.json` |
| `penelope_accept_match` | **ask (Auto-eligible)** | Record an accepted match in `accepted-matches.csv` |
| `penelope_request_adjusting_entry` | **ask · one-click** | After a named human approves, record an entry for a person to post |
| `ledger_post_journal` | **block** | Listed so agents see the refusal. Penelope never writes to a ledger. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

### MCP prompt

`month_end_bank_rec` (arguments `bank`, `gl`, `gl_balance`, optional `prior` and `rules`) walks a host model through read statement → reconcile → roll forward → workpaper → accepted matches and rules, and stops at the human click for adjusting entries.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `penelope-of-recon approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`penelope-of-recon kill`).

`penelope_accept_match` can go on Auto (`--mode auto --auto penelope_accept_match`). Adjusting entries change the books, so Penelope files them under `move_money`: they stay **one-click even in Auto**. Posting to a ledger stays **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
penelope-of-recon tools
penelope-of-recon call penelope_reconcile '{"bank":"bank.csv","gl":"gl-cash.csv","bank_balance":12422.88,"gl_balance":12844.76}'
penelope-of-recon eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not an accounting system or close tool. It reads exports and writes files; it never posts to a ledger, bank or ERP.
- No live bank or ledger connection: it reads files you export.
- Matching is rule-based. Low-confidence and group matches need a person's check, and a tie-out is only as good as the exports and balances you give it.
- Not accounting or audit advice.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/penelope-of-recon>
