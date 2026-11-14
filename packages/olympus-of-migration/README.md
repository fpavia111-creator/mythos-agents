# Olympus of Migration (`olympus-of-migration`)

> Check NetSuite / ERP migration exports before go-live. Read-only on your data. Never approves go-live.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Olympus compares what you exported from the old system with what landed in the new one (for example a NetSuite sandbox trial load) and writes a readiness report. It works on export files you already have (CSV, JSON or JSONL). It needs no NetSuite login and no credentials.

It finds:
- source records missing from the target, and extra target records;
- duplicate and blank keys;
- field values that differ (numbers compared by value, so `$1,200.00` equals `1200`);
- amount totals that do not tie;
- trial-balance accounts that do not tie, or whose balance is blank (reported as unknown, never guessed).

## Install

```bash
npm install -g olympus-of-migration
olympus-of-migration demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add olympus-of-migration -- npx -y olympus-of-migration@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "olympus-of-migration": { "command": "npx", "args": ["-y", "olympus-of-migration@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `olympus_compare_exports` | **allow** | Compare source vs target export |
| `olympus_tie_out_balances` | **allow** | Trial balance tie-out by account |
| `olympus_readiness_report` | **allow** | Write `readiness-report.md` + `findings.json` to `mythos-out/olympus` |
| `olympus_approve_go_live` | **block** | Listed so agents see the refusal. Go-live is a human decision. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `olympus-of-migration approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`olympus-of-migration kill`).

Every Olympus tool is read or report, so Auto changes nothing here. Go-live stays **blocked** in every mode.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
olympus-of-migration tools
olympus-of-migration call olympus_compare_exports '{"source":"legacy-open-invoices.csv","target":"sandbox-open-invoices.csv","key":"externalid","amount_column":"amount"}'
olympus-of-migration eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not an ERP, an importer or a migration tool. It does not load data.
- Not a guarantee that the books tie. It checks the files you give it.
- Not accounting, tax or audit advice, and not a certification.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/olympus-of-migration>
