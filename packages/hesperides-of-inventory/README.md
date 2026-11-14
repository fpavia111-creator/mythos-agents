# Hesperides of Inventory (`hesperides-of-inventory`)

> Compares cycle counts with your on-hand export, ranks variances by value and says which need a recount or an investigation. Posting an adjustment is one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Hesperides a count export (`sku, location, counted_qty, recount_qty, uom, counter, counted_at`), the on-hand snapshot from your system (`sku, location, description, system_qty, unit_cost, uom`) and, optionally, movements (`sku, location, posted_at, qty, type, ref`). For each item and location it:
- computes the variance in units and value, after taking out movements posted between the count and the snapshot (timing differences);
- sorts lines into match, within tolerance (`tolerance_pct` 2%, `tolerance_units` 0 by default, and under `value_threshold`, default 250), explained by timing, recount needed, confirmed by recount, investigate, or not counted;
- flags likely unit-of-measure errors (count and system differ by a pack factor such as 6, 12 or 24), recounts that disagree with the first count, negative system stock, items counted but not in the system, and mismatched units;
- ranks everything by absolute value and gives net and absolute totals.

It writes `variance-review.md` and `variances.csv` (blank reviewer and decision columns). With approval it drafts `adjustments-draft.csv` for lines within tolerance or confirmed by a recount only. Reason codes come from the person who reviewed them; Hesperides does not choose them.

## Install

```bash
npm install -g hesperides-of-inventory
hesperides-of-inventory demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add hesperides-of-inventory -- npx -y hesperides-of-inventory@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "hesperides-of-inventory": { "command": "npx", "args": ["-y", "hesperides-of-inventory@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `hesperides_compare` | **allow** | Status, flags and notes per item and location, ranked by value |
| `hesperides_write_report` | **allow** | Write `variance-review.md` and `variances.csv` to `mythos-out/hesperides` |
| `hesperides_draft_adjustments` | **ask (Auto-eligible)** | Draft `adjustments-draft.csv` + `adjustment.json` (nothing posted) |
| `hesperides_request_post` | **ask · one-click** | After a named human approves, record the adjustment (bound to its hash; every line needs a reason code) for whoever posts |
| `erp_post_adjustment` | **block** | Listed so agents see the refusal. Hesperides never writes to an ERP. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

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
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not an ERP, WMS or counting app. It reads exports and writes files; a person posts any adjustment.
- The rules are simple and stated. A line marked within tolerance is not proof it is right, and a pack-factor flag is a hint, not a diagnosis.
- Not accounting or audit advice.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/hesperides-of-inventory>
