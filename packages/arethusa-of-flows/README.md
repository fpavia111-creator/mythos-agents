# Arethusa of Flows (`arethusa-of-flows`)

> Audits workflow automation exports (n8n, Zapier, Make, Power Automate, Workato) and run history for broken and risky flows. Enabling or changing a production flow is one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Arethusa exported flow definitions (n8n workflow JSON, a Zapier-style export with `zaps[].steps[]`, a Make blueprint, a Power Automate / Logic Apps flow definition with `triggers` and `actions`, or a Workato recipe JSON — one recipe or an array) and, optionally, run history (`flow, run_at, status, error`). For each flow it reports, by severity:
- **broken**: no trigger, steps not connected to any trigger (n8n and Power Automate, from connections and `runAfter`), disabled steps, failing runs (≥ 20% of at least 3 runs) or a failed last run, active flows that have not run in `stale_days` (default 30), no error workflow or error route;
- **risky**: secrets typed into step settings (values are **never shown**; expressions and stored credentials are fine), webhooks with no authentication (a Power Automate HTTP trigger restricted to the tenant or specific users is not flagged), plain `http://` calls, deletes with no filter or condition before them, steps that can move money (Stripe, PayPal, refunds, payouts…), steps that send email, chat or SMS, shell commands or custom code.

**Secret detection** uses three signals and reports only the rule and the location, never the value:
- about 20 known formats (Stripe, Slack tokens and webhook URLs, Discord webhooks, AWS access key ids, GitHub, GitLab, Google API keys, OpenAI- and Anthropic-style keys, SendGrid, Twilio, Mailgun, Shopify, npm, JWTs, private key blocks, passwords in URLs, signed-URL `sig=`/`token=` parameters) → `hardcoded_secret` (high);
- any value of 8+ characters in a field named like a secret (`api_key`, `Authorization`, `password`, `client_secret` …) → `hardcoded_secret` (high);
- token-like strings with high Shannon entropy (default ≥ 20 characters and ≥ 4.0 bits/char; hex ≥ 32 characters and ≥ 3.0) that are not UUIDs, URLs, paths or prose → `possible_secret` (medium). Thresholds are set in the policy file, or `"entropy": false` turns this off.

**Dependency map** (`arethusa_dependency_map`): which stored credentials (n8n credentials, Power Automate connections, Workato accounts, Make connections, Zapier auth ids), hardcoded secrets, webhooks and hosts are shared between flows, and which flow calls another flow's n8n webhook. Equal secret values share a label (`secret#1`, `secret#2` …) so you can see the blast radius without seeing the value. It returns a **rotation plan** ranked P1–P3 with reasons (shared across flows, active flows depend on it, a flow using it can move money, known format or only high entropy).

**Policy file** (optional, `policy` argument, schema `policy`): `allow_http_hosts`, `fail_rate`, `stale_days`, `entropy` thresholds, and `ignore` rules (`flow`, `code`, `step`, a required `reason`, optional `until` date). Suppressed findings are still listed under `suppressed` and in the report; an expired suppression puts the finding back with a note. Check a file with `arethusa-of-flows validate-config policy arethusa-policy.json`. Hosts in `allow_http_hosts` are not reported as plain HTTP.

**Baseline**: pass an earlier `findings.csv` as `baseline` and each finding is marked `new` or `existing`, and resolved findings are listed.

Flows are ranked by a risk score. It writes `flow-audit.md`, `findings.csv` (blank owner and decision columns), `findings.sarif` (SARIF 2.1.0 for code-scanning dashboards; each result points at the export file and names the flow and step) and, with approval, a proposal per flow plus a redacted copy of each export with secrets replaced by placeholders (in URLs only the secret part is replaced). Report and dependency-map results carry `output_sha256`, which the audit log records.

## Install

```bash
npm install -g arethusa-of-flows
arethusa-of-flows demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add arethusa-of-flows -- npx -y arethusa-of-flows@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "arethusa-of-flows": { "command": "npx", "args": ["-y", "arethusa-of-flows@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `arethusa_audit` | **allow** | Findings and risk score per flow; secret values never returned |
| `arethusa_write_report` | **allow** | Write `flow-audit.md`, `findings.csv` and `findings.sarif` to `mythos-out/arethusa` |
| `arethusa_dependency_map` | **allow** | Shared credentials, secrets, webhooks and hosts; flow-to-flow calls; secret rotation plan; writes `dependency-map.md` (with a Mermaid graph) and `dependency-map.csv` |
| `arethusa_draft_changes` | **ask (Auto-eligible)** | Write proposals and `<export>.redacted.json` copies (nothing applied) |
| `arethusa_request_flow_change` | **ask · one-click** | After a named human approves, record an enable, disable or modify request for the flow owner |
| `automation_update_flow` | **block** | Listed so agents see the refusal. Arethusa never edits a platform. |
| `automation_run_flow` | **block** | Listed so agents see the refusal. Arethusa never runs a flow, so it never orders, sends or pays. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

### MCP prompt

`arethusa_flow_review` (arguments `exports`, optional `history`, `policy`, `baseline`) walks a host model through audit → dependency map and rotation plan → report and SARIF → drafted fixes → the one-click change requests a person approves.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `arethusa-of-flows approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`arethusa-of-flows kill`).

`arethusa_draft_changes` can go on Auto. Enabling, disabling or changing a production flow is a `production_deploy`: it stays **one-click even in Auto**, and `--auto arethusa_request_flow_change` is refused. Editing or running flows stays **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
arethusa-of-flows tools
arethusa-of-flows call arethusa_audit '{"exports":["n8n-orders.json","zapier-export.json","make-blueprint.json"],"history":"run-history.csv"}'
arethusa-of-flows eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- A static review of exported definitions, not a test run. It does not call the platform's API or execute any step.
- Pattern-based: platform export formats vary, so treat a clean result as "nothing found", not "safe". Power Automate support reads the flow definition (`properties.definition` or a bare `definition`); Workato support reads the recipe `code` tree and its `config` accounts. Neither reads solution packages (.zip) or platform-side settings such as connection owners.
- Secret detection can miss secrets in unusual formats and can flag random-looking ids as `possible_secret`; suppress those with a reason in the policy file. It cannot tell whether a found secret is still valid.
- Flow-to-flow calls are found for n8n webhook paths only; calls through other platforms' webhook URLs are listed as shared hosts.
- It never enables, edits or runs a flow, and never handles real payment details.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/arethusa-of-flows>
