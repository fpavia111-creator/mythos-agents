# Polyhymnia of Grants (`polyhymnia-of-grants`)

> Grant report prep from CSV exports: deadlines, budget pace, outcomes and evidence mapped into a draft packet with every gap marked. Submitting is a binding send: one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Polyhymnia your grants (`grant_id, funder, program, award_amount, period_start, period_end, report_due, report_type, status`), budget lines (`grant_id, line, budgeted, spent`) and outcomes (`grant_id, metric, target, actual, evidence`; evidence paths are relative to the outcomes file). It:
- lists report deadlines: overdue, due soon (≤ 30 days), upcoming, later and submitted;
- checks each budget line for overspend, and for spending ahead of or behind the share of the grant period that has passed (`pace_tolerance`, default 0.25); flags budget totals that differ from the award;
- checks each outcome for a missing actual, a result below target, and evidence that is missing or not found;
- builds a draft packet per grant: `report-draft.md` (budget and outcome tables, evidence references, `[EXPLAIN]` and `[MISSING]` markers), `checklist.md` and `evidence-index.csv` (with file hashes).

The narrative section is left as `[TO WRITE]` for a person. Polyhymnia does not write claims about your program.

## Install

```bash
npm install -g polyhymnia-of-grants
polyhymnia-of-grants demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add polyhymnia-of-grants -- npx -y polyhymnia-of-grants@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "polyhymnia-of-grants": { "command": "npx", "args": ["-y", "polyhymnia-of-grants@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `polyhymnia_deadlines` | **allow** | Report deadlines by status |
| `polyhymnia_review` | **allow** | Budget pace, outcomes, evidence and open items per grant |
| `polyhymnia_build_packet` | **ask (Auto-eligible)** | Write draft packets to `mythos-out/polyhymnia/packets/<grant_id>` |
| `polyhymnia_request_submission` | **ask · one-click** | After a named human approves, record a packet as approved to submit (warns about open markers) |
| `funder_portal_submit` | **block** | Listed so agents see the refusal. Polyhymnia never submits. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `polyhymnia-of-grants approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`polyhymnia-of-grants kill`).

`polyhymnia_build_packet` can go on Auto. Submitting a report to a funder is a `binding_send`: it stays **one-click even in Auto**, and `--auto polyhymnia_request_submission` is refused. Submitting in a funder portal stays **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
polyhymnia-of-grants tools
polyhymnia-of-grants call polyhymnia_review '{"grants":"grants.csv","budget":"budget.csv","outcomes":"outcomes.csv"}'
polyhymnia-of-grants eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not a grant management system, and it does not make you compliant with any funder or federal rule. It checks the figures and files you give it.
- It does not write your narrative or explain variances; it marks where a person must.
- It never submits anything to a funder.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/polyhymnia-of-grants>
