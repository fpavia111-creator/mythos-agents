# Auxo of Vendors (`auxo-of-vendors`)

> Vendor W-9 readiness from CSV exports: what is missing, what needs fixing and who to ask, with request drafts. Sending is one human click. It never files with the IRS and is not tax advice.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Auxo a vendor export (`vendor_id, name, legal_name, entity_type, country, tin, w9_received, w9_signed, address, email, requested_date`, plus `w8_received, w8_type, w8_signed` for non-US vendors) and, optionally, payments (`vendor_id, date, amount, method`). For each vendor it reports:
- a status: `ready`, `request_w9`, `fix_details` (unsigned form, missing TIN, TIN format or pattern problem, LLC classification missing), `review` (form older than `refresh_years`, default 3) or `ask_preparer` (non-US vendor);
- the TIN **masked** (`•••••1234`). Full TINs are never returned, written or logged;
- **TIN pattern rules per entity type**: EIN prefixes the IRS has never assigned (for example 00, 07–09, 17–19), SSN numbers that are never issued (area 000, 666 or 900–999, group 00, serial 0000), ITIN middle-digit ranges, placeholder numbers (all one digit, 123456789), and the wrong kind of number for the entity type (an SSN-style number for a corporation or partnership, an EIN for an individual who is not a sole proprietor). These are structure checks only: a number that passes is not verified, and Auxo does not do IRS TIN matching;
- the expected form and a **checklist**: W-9 items for US vendors; for non-US vendors the **W-8 checklist** instead (W-8 on file, signed, still within its usual validity period — generally the end of the third calendar year after signing — and the form usually used for the entity type, W-8BEN or W-8BEN-E). Which W-8 applies is your preparer's call; Auxo only suggests the usual one;
- payments for the year by non-card methods, with card and payment-app amounts listed separately, against a threshold. The default is 600 for payments before 2026 and 2000 for 2026. For later years the figure is inflation-adjusted, so Auxo marks it unconfirmed until you pass `threshold`;
- a priority (high if over the threshold and not ready) and whether a first request or a reminder is due (`remind_days`, default 7).

It also:
- writes a **1099 readiness summary** (`auxo_1099_readiness`): US vendors at or over the threshold and what each still lacks, non-US vendors over the threshold with their W-8 state, payees paid only by card or app, and payments with no vendor record. `1099-readiness.md` and `.csv`, TINs masked, output hash in the audit line. It is not a filing;
- **finds duplicate vendor records** (`auxo_find_duplicates`): same TIN (compared in memory, never shown), near-identical legal names, same address or email, and pairs whose combined payments reach the threshold while each record alone does not (`split_under_threshold`). A person decides whether to merge.

It writes `w9-tracker.csv` (expected form, open checklist items, blank owner and follow-up columns) and `readiness.md`, and drafts W-9 or W-8 request and reminder emails marked DRAFT. The drafts ask vendors to use your secure upload link rather than email a TIN.

<!-- sources:start -->
## Exports it reads

Table inputs can be CSV, TSV, semicolon- or pipe-separated text, Excel `.xlsx`, JSON or JSONL. A file already in this agent's own columns is read as it is. The exports below are recognised by their column names and mapped onto those columns; dates become `YYYY-MM-DD`, amounts plain decimals (both decimal marks), and yes/no columns `yes`/`no`. Each result lists, under `sources`, which export was recognised, which columns were mapped, and any rows skipped or dates that could be read two ways.

**Vendor master** (argument `vendors`)

| System | Export | Layout checked against vendor docs |
|---|---|---|
| NetSuite | Vendor saved search (default column labels) | no |
| QuickBooks Online | Vendor Contact List report (CSV or Excel) | no |
| Xero | Contacts > Export (CSV) | no |

**Payments to vendors** (argument `payments`)

| System | Export | Layout checked against vendor docs |
|---|---|---|
| NetSuite | Transaction saved search (default column labels) | no |
| QuickBooks Online | Transaction List by Vendor report (CSV or Excel) | no |

Columns named differently? Run `npx auxo-of-vendors inspect <file>` to see how a file is read (column names and shapes only, never values), then name your columns in `mythos-sources.json` in the root:

```json
{ "files": { "exports/users.csv": { "columns": { "email": "Work E-mail" }, "date_order": "dmy" } } }
```

Where a layout says "checked", its column names were compared with the vendor's documentation on that date. The other layouts were written from knowledge of the export and were not checked. None was tested against a live account. If a real export does not match, the result says which columns were missing; please report it.
<!-- sources:end -->

## Install

```bash
npm install -g auxo-of-vendors
auxo-of-vendors demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add auxo-of-vendors -- npx -y auxo-of-vendors@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "auxo-of-vendors": { "command": "npx", "args": ["-y", "auxo-of-vendors@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `auxo_check` | **allow** | Status, flags, masked TIN, payment totals and priority per vendor |
| `auxo_write_tracker` | **allow** | Write `w9-tracker.csv` and `readiness.md` to `mythos-out/auxo` |
| `auxo_1099_readiness` | **allow** | Write `1099-readiness.md` and `.csv`: who is over the threshold and what is missing. Not a filing |
| `auxo_find_duplicates` | **allow** | Possible duplicate vendor records and payments split under the threshold |
| `auxo_draft_requests` | **ask (Auto-eligible)** | Write request and reminder drafts to `mythos-out/auxo/requests` (not sent) |
| `auxo_request_send` | **ask · one-click** | After a named human approves, record a draft as approved to send |
| `irs_efile` | **block** | Listed so agents see the refusal. Auxo never files with the IRS. |
| `send_email` | **block** | Listed so agents see the refusal. Auxo never sends. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## MCP prompt

`auxo_year_end_readiness` (arguments `vendors`, `payments`, optional `year`, `threshold`) walks a host model through check, duplicates, 1099 readiness, tracker, drafts and the human send step, and tells it never to print a full TIN or give tax advice.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `auxo-of-vendors approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`auxo-of-vendors kill`).

`auxo_draft_requests` can go on Auto. Sending a request to a vendor is a `binding_send`: it stays **one-click even in Auto**, and `--auto auxo_request_send` is refused. E-filing and sending stay **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
auxo-of-vendors tools
auxo-of-vendors call auxo_check '{"vendors":"vendors.csv","payments":"payments.csv","year":2026}'
auxo-of-vendors eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not tax advice. It does not decide who is reportable, which form applies, or how card payments are treated; your preparer does.
- Not a filing product. It never files information returns with the IRS or any agency, and it does not validate TINs with the IRS (TIN matching). Its TIN checks are structure checks: they catch numbers that cannot be right, not numbers that are wrong.
- For non-US vendors it tracks whether a W-8 is on file, signed and recent, and suggests the usual form. It does not decide which form applies, treaty claims or withholding; your preparer does.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/auxo-of-vendors>
