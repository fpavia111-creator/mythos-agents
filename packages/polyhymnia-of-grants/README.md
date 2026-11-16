# Polyhymnia of Grants (`polyhymnia-of-grants`)

> Grant report prep from CSV exports: deadlines, budget pace, outcomes and evidence mapped into a draft packet with every gap marked. Submitting is a binding send: one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Polyhymnia your grants (`grant_id, funder, program, award_amount, period_start, period_end, report_due, report_type, status`), budget lines (`grant_id, line, budgeted, spent`) and outcomes (`grant_id, metric, target, actual, evidence`; evidence paths are relative to the outcomes file). It:
- lists report deadlines: overdue, due soon (≤ 30 days), upcoming, later and submitted;
- checks each budget line for overspend, and for spending ahead of or behind the share of the grant period that has passed (`pace_tolerance`, default 0.25); flags budget totals that differ from the award;
- checks each outcome for a missing actual, a result below target, and evidence that is missing or not found;
- computes **budget-vs-actual variance by line** (`polyhymnia_variance`): against the full budget for final reports or once the period has ended, otherwise against the share expected by now. A line whose variance is more than `variance_pct` (default 10%) and at least `variance_amount` (default 0) gets an `[EXPLAIN VARIANCE — …]` marker; an `explanation` column in your budget file is carried through but still marked for a person to check. It also projects spend at the current pace to the end of the period (`projected_underspend` / `projected_overspend`, `underspend_pct`, default 10%);
- maps a **funder template** (`polyhymnia_template_check`, and `template` on `polyhymnia_build_packet`): a JSON file listing the funder's sections in order (each filled from `summary`, `budget`, `variance`, `outcomes`, `evidence`, `deadlines`, or left `[TO WRITE]` for `narrative`/`custom`), word limits, the funder's own guidance text, required attachments (paths relative to the outcomes file) and an optional variance threshold. Missing required sections and attachments, and a template meant for another funder, are flagged. The template is schema-checked, so a typo fails with the exact JSON path (`polyhymnia-of-grants validate-config funder_template template.json`). You write the template from the funder's instructions; Polyhymnia does not know any funder's rules;
- builds a draft packet per grant: `report-draft.md` (budget, variance and outcome tables, evidence references, `[EXPLAIN]` and `[MISSING]` markers; in template order when a template is given), `checklist.md` and `evidence-index.csv` (with file hashes);
- writes a **deadline calendar** (`polyhymnia_calendar`): `grant-deadlines.ics` with each open report deadline and grant period end and reminders (default 30, 14, 7 and 1 days before), validated before it is written;
- assembles an **evidence pack** (`polyhymnia_evidence_pack`): a zip of one grant's draft packet, the evidence files it cites, `variance.csv` and a `manifest.json` with SHA-256 hashes; the zip hash is written into the audit line.

The narrative section is left as `[TO WRITE]` for a person. Polyhymnia does not write claims about your program.

## Install

```bash
npm install -g polyhymnia-of-grants
polyhymnia-of-grants demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add polyhymnia-of-grants -- npx -y polyhymnia-of-grants@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "polyhymnia-of-grants": { "command": "npx", "args": ["-y", "polyhymnia-of-grants@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `polyhymnia_deadlines` | **allow** | Report deadlines by status |
| `polyhymnia_review` | **allow** | Budget pace, outcomes, evidence and open items per grant |
| `polyhymnia_variance` | **allow** | Budget-vs-actual variance by line, explanation flags, spend-down projection |
| `polyhymnia_template_check` | **allow** | Map a funder template onto each grant: filled, to write, missing |
| `polyhymnia_calendar` | **allow** | Write `grant-deadlines.ics` with reminders |
| `polyhymnia_build_packet` | **ask (Auto-eligible)** | Write draft packets to `mythos-out/polyhymnia/packets/<grant_id>` (optionally in template order) |
| `polyhymnia_evidence_pack` | **ask (Auto-eligible)** | Zip a packet, its evidence and a hash manifest |
| `polyhymnia_request_submission` | **ask · one-click** | After a named human approves, record a packet as approved to submit (warns about open markers) |
| `funder_portal_submit` | **block** | Listed so agents see the refusal. Polyhymnia never submits. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## MCP prompt

`polyhymnia_report_cycle` (arguments `grants`, `budget`, `outcomes`, optional `template`, `grant_id`, `as_of`) walks a host model through deadlines, calendar, review, variance, template check, packet, evidence pack and the human submission click, and tells it not to write narrative or variance explanations itself.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `polyhymnia-of-grants approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`polyhymnia-of-grants kill`).

`polyhymnia_build_packet` and `polyhymnia_evidence_pack` can go on Auto if you opt in. Submitting a report to a funder is a `binding_send`: it stays **one-click even in Auto**, and `--auto polyhymnia_request_submission` is refused. Submitting in a funder portal stays **blocked**.

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
- It does not know any funder's template or rules. Templates are files you write from the funder's instructions.
- It never submits anything to a funder.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/polyhymnia-of-grants>
