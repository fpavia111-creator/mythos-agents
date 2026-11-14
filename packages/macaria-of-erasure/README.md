# Macaria of Erasure (`macaria-of-erasure`)

> A data-subject erasure request workflow over your exports: where the person's data lives, what you may have to keep, and a checklist. Deleting is one human click; Macaria never deletes.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Point Macaria at a folder of exports (CSV, JSON, JSONL) from your CRM, support desk, newsletter tool, billing and so on. It:
- maps which columns look like personal data (email, phone, name, address, birth date, IP address, government id, payment details, customer id);
- finds the requester's rows by email (case-insensitive), phone (last 10 digits) or customer id;
- flags files that look like records you may have to retain (invoices, tax, payroll, orders, contracts);
- builds a checklist: verify identity first, log the request with a response target (GDPR 30 days, CCPA/CPRA 45 days by default; confirm what applies to you), one step per file, processors and vendors, confirmation to the requester. Owner and evidence columns are blank.

Identifiers are masked in every output (`j***@example.com`); logs carry a hash key instead of the raw value.

## Install

```bash
npm install -g macaria-of-erasure
macaria-of-erasure demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add macaria-of-erasure -- npx -y macaria-of-erasure@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "macaria-of-erasure": { "command": "npx", "args": ["-y", "macaria-of-erasure@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `macaria_map_data` | **allow** | Inventory personal-data columns and retention flags |
| `macaria_find_subject` | **allow** | Find the subject's rows; identifiers masked |
| `macaria_build_checklist` | **allow** | Write `erasure-checklist.csv` + `erasure-request.md` to `mythos-out/macaria` |
| `macaria_log_request` | **ask (Auto-eligible)** | Add the request to `requests.csv` with a target date |
| `macaria_request_deletion` | **ask · one-click** | After a named human approves, record a deletion for one system's owner |
| `macaria_delete_records` | **block** | Listed so agents see the refusal. Macaria never deletes or edits data. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `macaria-of-erasure approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`macaria-of-erasure kill`).

`macaria_log_request` can go on Auto. Deleting personal data is `delete_personal_data`: it stays **one-click even in Auto**, and `--auto macaria_request_deletion` is refused. Deleting directly stays **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
macaria-of-erasure tools
macaria-of-erasure call macaria_find_subject '{"dir":"exports","email":"jamie.doe@example.com","ids":["C-101"]}'
macaria-of-erasure eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not legal advice and not a privacy compliance platform. It does not decide whether an exemption applies or which deadline is yours.
- It only sees the exports you give it. Systems, backups and processors you did not export are not covered.
- Column detection is by name. A free-text field that holds an email will be found by the subject search but may not appear in the column inventory.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/macaria-of-erasure>
