# Macaria of Erasure (`macaria-of-erasure`)

> A data-subject erasure request workflow over your exports: where the person's data lives, what you may have to keep, and a checklist. Deleting is one human click; Macaria never deletes.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Point Macaria at a folder of exports (CSV, JSON, JSONL) from your CRM, support desk, newsletter tool, billing and so on. It:
- maps which columns look like personal data (email, phone, name, address, birth date, IP address, government id, payment details, customer id);
- finds the requester's rows by email (case-insensitive), phone (last 10 digits) or customer id, and also in pseudonymised exports where the email or phone is stored as a SHA-256 or MD5 hash (ad audiences, ESP subscriber hashes). Output says which column matched and how, never the value;
- flags files that look like records you may have to retain (invoices, tax, payroll, orders, contracts);
- applies **your own retention rules and legal holds** (a JSON file you write) to the matched rows, holds first, and cites the rule or hold id for every row: on hold, retain until a date, period ended, date missing, or no rule;
- tracks request deadlines from the request log: due date from the response period you configure, overdue and due-soon requests first, optional `.ics` calendar with reminders;
- writes an evidence pack per request (JSON + self-contained HTML): exports searched with their SHA-256, rows found and how they matched, retention decisions with rule ids, approved deletion requests, what is kept and what is still open. The JSON's hash goes into the audit log line;
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
claude mcp add macaria-of-erasure -- npx -y macaria-of-erasure@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "macaria-of-erasure": { "command": "npx", "args": ["-y", "macaria-of-erasure@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `macaria_map_data` | **allow** | Inventory personal-data columns and retention flags |
| `macaria_find_subject` | **allow** | Find the subject's rows; identifiers masked |
| `macaria_build_checklist` | **allow** | Write `erasure-checklist.csv` + `erasure-request.md` to `mythos-out/macaria`; with `rules`, retention steps cite your rule and hold ids |
| `macaria_retention_check` | **allow** | Apply your retention rules and legal holds to the matched rows; rule id per row |
| `macaria_deadlines` | **allow** | Request deadline tracker over `requests.csv`: `request-deadlines.csv`, optional `.ics` |
| `macaria_evidence_pack` | **allow** | `evidence-<key>.json` + `.html` for one request; hash recorded in the audit log |
| `macaria_log_request` | **ask (Auto-eligible)** | Add the request to `requests.csv` with a target date |
| `macaria_request_deletion` | **ask · one-click** | After a named human approves, record a deletion for one system's owner |
| `macaria_delete_records` | **block** | Listed so agents see the refusal. Macaria never deletes or edits data. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

### Retention rules file

```json
{
  "response_periods": { "gdpr": 30, "ccpa": 45 },
  "due_soon_days": 7,
  "retention_rules": [
    { "id": "RET-INV-7Y", "record_type": "invoices", "file_pattern": "invoice", "date_column": "date", "keep_days": 2555, "action_after": "delete", "basis": "your note" }
  ],
  "legal_holds": [ { "id": "HOLD-1", "file_pattern": "support-tickets", "until": "2027-06-30", "note": "open dispute" } ]
}
```

`file_pattern` is plain text the export's path contains (case-insensitive). The file is checked against a schema; a typo such as `keep_dayz` fails with a JSON pointer. Check it first with `macaria-of-erasure validate-config retention_rules rules.json`. The rules are yours: Macaria applies them and cites them, it does not decide which rule or exemption applies.

### MCP prompt

`erasure_request_workflow` walks the host model through one request: map, find, retention, log, checklist, deletion requests (each waits for a named person), deadlines and the evidence pack.

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
- Hashed matching covers SHA-256/MD5 of the lower-cased email and SHA-256 of common phone forms (last 10 digits, all digits, `+digits`, `+1` + 10 digits). Salted or keyed hashes, and other normalisations, will not match.
- Deadlines come from the periods you configure (defaults: 30 days GDPR/UK GDPR, 45 days CCPA/CPRA). Extensions and pauses are not modelled.
- The evidence pack records what this tool saw and recorded. It is not a certification and does not prove deletion in the source system.
- Column detection is by name. A free-text field that holds an email will be found by the subject search but may not appear in the column inventory.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/macaria-of-erasure>
