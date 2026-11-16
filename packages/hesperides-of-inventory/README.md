# Hesperides of Inventory (`hesperides-of-inventory`)

> Compares cycle counts with your on-hand export, ranks variances by value and says which need a recount or an investigation. Posting an adjustment is one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Hesperides a count export (`sku, location, counted_qty, recount_qty, uom, counter, counted_at`), the on-hand snapshot from your system (`sku, location, description, system_qty, unit_cost, uom`) and, optionally, movements (`sku, location, posted_at, qty, type, ref`). For each item and location it:
- computes the variance in units and value, after taking out movements posted between the count and the snapshot (timing differences);
- sorts lines into match, within tolerance (`tolerance_pct` 2%, `tolerance_units` 0 by default, and under `value_threshold`, default 250), explained by timing, recount needed, confirmed by recount, investigate, or not counted;
- flags likely unit-of-measure errors (count and system differ by a pack factor such as 6, 12 or 24), recounts that disagree with the first count, negative system stock, items counted but not in the system, and mismatched units;
- compares per lot or serial when the exports have a `lot` (or `serial`) column, matches movements per lot, and flags lot mix-ups (per-lot variances at one item and location that net to zero) and serial numbers counted more than once;
- with a unit-of-measure table (`uom_table`), converts counts taken in another unit (`2 CS × 12 = 24 EA`) and explains likely case-vs-each errors with your factor and the arithmetic;
- ranks everything by absolute value and gives net and absolute totals.

It writes `variance-review.md`, `variances.csv` (blank reviewer and decision columns) and `recount-sheet.csv`, a blind sheet (no system quantities) for the lines that need a recount or investigation.

It also:
- plans counts: ranks items A/B/C by value (annual usage × cost when the export has `annual_usage`, otherwise on-hand value) and spreads counts over your working days so A items are counted most often. It writes `abc-classes.csv`, blind count sheets (`count-plan.csv`) and a calendar (`count-plan.ics`);
- reports inventory record accuracy (share of counted lines within tolerance) and value accuracy, overall and by location, counter and ABC class, with the change since your previous count. With approval it drafts `adjustments-draft.csv` for lines within tolerance or confirmed by a recount only. Reason codes come from the person who reviewed them; Hesperides does not choose them.

<!-- sources:start -->
## Exports it reads

Table inputs can be CSV, TSV, semicolon- or pipe-separated text, Excel `.xlsx`, JSON or JSONL. A file already in this agent's own columns is read as it is. The exports below are recognised by their column names and mapped onto those columns; dates become `YYYY-MM-DD`, amounts plain decimals (both decimal marks), and yes/no columns `yes`/`no`. Each result lists, under `sources`, which export was recognised, which columns were mapped, and any rows skipped or dates that could be read two ways.

**System on-hand quantities** (argument `on_hand`)

| System | Export | Layout checked against vendor docs |
|---|---|---|
| NetSuite | Item saved search with location quantities | no |
| Shopify | Products > Inventory > Export (CSV) | no |

**Count sheet** (arguments `counts`, `previous_counts`)

No named exports: other column names are matched by a list of common alternatives.

Columns named differently? Run `npx hesperides-of-inventory inspect <file>` to see how a file is read (column names and shapes only, never values), then name your columns in `mythos-sources.json` in the root:

```json
{ "files": { "exports/users.csv": { "columns": { "email": "Work E-mail" }, "date_order": "dmy" } } }
```

Where a layout says "checked", its column names were compared with the vendor's documentation on that date. The other layouts were written from knowledge of the export and were not checked. None was tested against a live account. If a real export does not match, the result says which columns were missing; please report it.
<!-- sources:end -->

## Install

```bash
npm install -g hesperides-of-inventory
hesperides-of-inventory demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add hesperides-of-inventory -- npx -y hesperides-of-inventory@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "hesperides-of-inventory": { "command": "npx", "args": ["-y", "hesperides-of-inventory@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `hesperides_compare` | **allow** | Status, flags and notes per item and location, ranked by value |
| `hesperides_write_report` | **allow** | Write `variance-review.md`, `variances.csv` and a blind `recount-sheet.csv` to `mythos-out/hesperides` |
| `hesperides_count_plan` | **allow** | ABC classes, blind count sheets and a `.ics` count calendar |
| `hesperides_accuracy` | **allow** | Record and value accuracy by location, counter and class, with change since the last count |
| `hesperides_draft_adjustments` | **ask (Auto-eligible)** | Draft `adjustments-draft.csv` + `adjustment.json` (nothing posted) |
| `hesperides_request_post` | **ask · one-click** | After a named human approves, record the adjustment (bound to its hash; every line needs a reason code) for whoever posts |
| `erp_post_adjustment` | **block** | Listed so agents see the refusal. Hesperides never writes to an ERP. |

CSV files are written so that a spreadsheet does not run cell text as a formula: a cell that starts with `=`, or with `+`, `-` or `@` in a way a spreadsheet would run as a formula, gets a leading apostrophe. Plain numbers, phone-style values and `@handles` are left as they are. If you import the file somewhere else, such a cell arrives with the apostrophe.

Any other tool name is blocked. MCP hosts also get the prompt `cycle_count_review`, which walks a model through the whole count review and stops for the human click. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `hesperides-of-inventory approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`hesperides-of-inventory kill`).

`hesperides_draft_adjustments` can go on Auto, so Auto only pre-stages. An inventory adjustment changes cost of goods and the books, so Hesperides files posting under `move_money` (the same category as ledger postings in other Mythos packs): it stays **one-click even in Auto**, and `--auto hesperides_request_post` is refused. Posting to an ERP stays **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
hesperides-of-inventory tools
hesperides-of-inventory call hesperides_compare '{"counts":"counts.csv","on_hand":"on-hand.csv","transactions":"transactions.csv","snapshot_at":"2026-11-13"}'
hesperides-of-inventory eval          # private evals on the bundled fixtures
hesperides-of-inventory validate-config uom_table uom-table.json
hesperides-of-inventory validate-config count_policy count-policy.json
```

Reason codes for lot lines are keyed `"SKU@LOCATION#LOT"`. Config files are checked against a JSON Schema: unknown keys, wrong types and missing fields fail with the JSON pointer of the problem.

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not an ERP, WMS or counting app. It reads exports and writes files; a person posts any adjustment.
- The rules are simple and stated. A line marked within tolerance is not proof it is right, and a pack-factor flag is a hint, not a diagnosis.
- Not accounting or audit advice. Accuracy figures are computed from the files you supply with the stated rules; they are not an audit opinion.
- A lot mix-up flag is a hint from arithmetic (variances that cancel out), not proof of a mislabel.
- The count plan is a schedule; it does not track whether counts happened.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/hesperides-of-inventory>
