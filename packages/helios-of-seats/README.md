# Helios of Seats (`helios-of-seats`)

> Find unused, idle, duplicate and over-tiered SaaS seats (AI tools included) and estimate the saving. Revoking is one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Helios a seat export (`app, user, email, tier, monthly_cost, last_active, premium_features_used, status`; column names matched loosely) and, optionally, an HR roster (`email, status`). It flags:
- seats never used, or idle longer than `idle_days` (default 60);
- duplicate seats for the same person in the same app;
- leavers (terminated in HR) and people missing from the roster;
- premium tiers (Pro, Business, Enterprise, Team…) where premium features are marked unused.

Each seat gets a suggested action and an estimated monthly saving (a downgrade saves `downgrade_ratio` of the cost, default 0.5); seats with no cost are counted separately, never guessed. It writes a review sheet with blank reviewer columns.

**Renewal-aware savings.** Savings on an annual contract only land at renewal. Give Helios contract terms per app (in a `helios-policy.json`, or a contracts CSV with `app, billing, renewal_date, notice_days, min_seats, owner`) and it adds:
- an **act-by date** (renewal date minus notice days) and a prioritised **Act first** list, soonest deadline first;
- `est_saving_next_12m`: the saving over the next 12 months, pro-rated by day from the renewal date (monthly billing counts from `as_of`; a passed notice window moves the saving to the following renewal and flags `notice_window_passed`);
- contract minimums (`min_seats`): removals below the minimum are flagged `contract_minimum_N` and not counted as savings; and a recommended seat count to true-down to at renewal;
- per-app `idle_days` and `downgrade_ratio` overrides.

**Also:** a renewal calendar (`renewals.ics`, notice-due and renewal events with reminders), **owner confirmation drafts** (one Markdown draft per app owner, roster managers in Cc, keep/remove boxes; never sent), and a **comparison of two exports** (seats added and removed, waste resolved, new waste, seats still flagged since last time, cost changes, spend and waste change).

<!-- sources:start -->
## Exports it reads

Table inputs can be CSV, TSV, semicolon- or pipe-separated text, Excel `.xlsx`, JSON or JSONL. A file already in this agent's own columns is read as it is. The exports below are recognised by their column names and mapped onto those columns; dates become `YYYY-MM-DD`, amounts plain decimals (both decimal marks), and yes/no columns `yes`/`no`. Each result lists, under `sources`, which export was recognised, which columns were mapped, and any rows skipped or dates that could be read two ways.

**Seat or licence export** (arguments `seats`, `previous`)

| System | Export | Layout checked against vendor docs |
|---|---|---|
| Microsoft 365 usage reports | Active users report detail (CSV) | no |
| Google Workspace Admin | Users > Download users (CSV) | no |
| GitHub Copilot | Seat assignments API JSON (GET /orgs/{org}/copilot/billing/seats) | no |
| Atlassian Administration | Directory > Users > Export users (CSV) | no |

**HR roster** (argument `roster`)

| System | Export | Layout checked against vendor docs |
|---|---|---|
| BambooHR | Employee report (CSV or Excel) | no |
| Google Workspace Admin | Users > Download users (CSV) | no |

Columns named differently? Run `npx helios-of-seats inspect <file>` to see how a file is read (column names and shapes only, never values), then name your columns in `mythos-sources.json` in the root:

```json
{ "files": { "exports/users.csv": { "columns": { "email": "Work E-mail" }, "date_order": "dmy" } } }
```

Where a layout says "checked", its column names were compared with the vendor's documentation on that date. The other layouts were written from knowledge of the export and were not checked. None was tested against a live account. If a real export does not match, the result says which columns were missing; please report it.
<!-- sources:end -->

## Install

```bash
npm install -g helios-of-seats
helios-of-seats demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add helios-of-seats -- npx -y helios-of-seats@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "helios-of-seats": { "command": "npx", "args": ["-y", "helios-of-seats@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `helios_find_waste` | **allow** | Flag waste, per seat and per app, with estimated savings |
| `helios_write_review` | **allow** | Write `seat-review.csv`, `renewal-actions.csv` and a summary to `mythos-out/helios` |
| `helios_renewal_calendar` | **allow** | Write `renewals.ics` (notice-due and renewal events) |
| `helios_draft_confirmations` | **allow** | Write owner confirmation drafts (Markdown) and `drafts-index.csv`; sends nothing |
| `helios_compare_reviews` | **allow** | Compare an earlier export with the current one |
| `helios_request_downgrade` | **ask (Auto-eligible)** | Record a downgrade request for the app admin |
| `helios_request_revoke` | **ask · one-click** | After a named human approves, record a revocation request for the app admin |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision. Report tools record the hash of what they wrote in the audit log (`output_sha256`).

### Prompt

`helios_seat_review` (MCP prompt) walks a host model through the review: find waste, act-by order, compare with last time, write the sheet, calendar and owner drafts, then record only owner-confirmed changes. Arguments: `seats` (required), `roster`, `policy`, `as_of`.

## Contract terms (`helios-policy.json`)

```json
{
  "idle_days": 60,
  "default_owner": "it-admin@example.com",
  "apps": {
    "Salesforce": { "billing": "annual", "renewal_date": "2027-03-01", "notice_days": 60, "min_seats": 1, "owner": "sales-ops@example.com" },
    "Figma": { "billing": "monthly", "owner": "design-lead@example.com", "idle_days": 30 }
  }
}
```

The file is checked against a JSON Schema before use; a typo fails with a JSON-pointer path (for example `/apps/Zoom/billing must be one of "monthly", "annual"`). Check it yourself with `helios-of-seats validate-config helios-policy helios-policy.json`.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `helios-of-seats approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`helios-of-seats kill`).

`helios_request_downgrade` can go on Auto (`--mode auto --auto helios_request_downgrade`). Revoking a seat is `revoke_access`: it stays **one-click even in Auto**, and `--auto helios_request_revoke` is refused.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
helios-of-seats tools
helios-of-seats call helios_find_waste '{"seats":"seats.csv","roster":"hr-roster.csv","idle_days":60}'
helios-of-seats call helios_find_waste '{"seats":"seats.csv","policy":"helios-policy.json","as_of":"2026-11-14"}'
helios-of-seats call helios_compare_reviews '{"previous":"seats-october.csv","seats":"seats.csv"}'
helios-of-seats eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not a SaaS management platform. It connects to no app and changes no seat; an admin does that.
- Savings are estimates from your cost column. Renewal timing uses only the terms you give it; true-up clauses, tiered pricing, partial-term credits and price changes at renewal are not modelled. Without terms, savings are counted from `as_of`.
- Confirmation drafts are files for a person to review and send. Helios has no email or chat connection and sends nothing.
- No live SaaS admin connectors yet (planned once the shared connector layer exists); it reads exports only.
- `last_active` is only as good as the export it came from.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/helios-of-seats>
