# Augeas of Masters (`augeas-of-masters`)

> Find duplicate vendors and items in master-data exports, and apply one approved merge at a time to a copy. Never edits your ERP.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Augeas reads a vendor or item export (CSV/JSON) and clusters likely duplicates using:
- normalized names (case, accents, punctuation and suffixes like Inc, LLC, Ltd, GmbH removed) and character-bigram similarity;
- tax id (vendors) or UPC / part number (items);
- supporting signals: business email domain, phone, address.

Two records with **different tax ids** are flagged as possibly separate legal entities and are not clustered. Each cluster gets a suggested survivor (active and most complete), reasons and a confidence score. Merges are applied **one at a time to a copy** (`<name>.merged.csv`, with a `merged_into` column); the input file is never modified.

## Install

```bash
npm install -g augeas-of-masters
augeas-of-masters demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add augeas-of-masters -- npx -y augeas-of-masters@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "augeas-of-masters": { "command": "npx", "args": ["-y", "augeas-of-masters@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `augeas_find_duplicates` | **allow** | Cluster duplicates with reasons |
| `augeas_propose_merges` | **allow** | Write `merge-proposals.csv/json` to `mythos-out/augeas` |
| `augeas_apply_merge` | **ask (Auto-eligible)** | Apply one merge to the copy |
| `augeas_pay_vendor` | **block** | Listed so agents see the refusal. Augeas never moves money. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `augeas-of-masters approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`augeas-of-masters kill`).

`augeas_apply_merge` is the one action you can put on Auto: `--mode auto --auto augeas_apply_merge --max-steps 25`. Each merge is still logged, the cap stops a runaway, and `kill` stops everything. Moving money stays **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
augeas-of-masters tools
augeas-of-masters call augeas_find_duplicates '{"path":"vendors.csv","kind":"vendor"}'
augeas-of-masters eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not an MDM platform, and it does not write to NetSuite or any ERP. You load the reviewed result yourself.
- Matching is heuristic. Check open transactions, balances, bank details and 1099/tax status before merging in the ERP.
- It does not touch bank details or payments.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/augeas-of-masters>
