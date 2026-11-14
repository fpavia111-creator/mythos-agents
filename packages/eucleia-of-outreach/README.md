# Eucleia of Outreach (`eucleia-of-outreach`)

> A draft-only gate in front of outreach email. Checks every draft; never sends. Releasing a batch is one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Eucleia checks outreach drafts (CSV/JSON: `to, subject, body, send_at`) before a person sends them from their own mail tool. A draft is **held** if any check fails:
- the address or its domain is on your suppression list, or it is a duplicate in the batch;
- the subject is empty or 30 characters or more, or starts with a fake `RE:`/`FWD:` on a first email;
- the body is empty or 100 words or more;
- the sender name, a postal address or an unsubscribe method (the footer fields the US CAN-SPAM Act asks for) is missing;
- `send_at` is outside the send window: Tuesday or Wednesday, 8:00–17:00 America/Chicago by default (all limits are configurable). Held drafts get the next open slot.

It writes `ready.csv`, `held.csv` and one text file per ready draft with the footer added. Releasing a batch re-checks everything and writes `release.json` (a sha256 per draft) for the person who sends.

## Install

```bash
npm install -g eucleia-of-outreach
eucleia-of-outreach demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add eucleia-of-outreach -- npx -y eucleia-of-outreach@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "eucleia-of-outreach": { "command": "npx", "args": ["-y", "eucleia-of-outreach@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `eucleia_check_draft` | **allow** | Check one draft; every failure listed |
| `eucleia_check_batch` | **allow** | Check a CSV/JSON batch |
| `eucleia_prepare_outbox` | **allow** | Write `ready.csv`, `held.csv` and `drafts/` to `mythos-out/eucleia` |
| `eucleia_add_suppression` | **ask (Auto-eligible)** | Add an opt-out to the suppression list (adds only, never removes) |
| `eucleia_release_batch` | **ask · one-click** | Re-check and write `release.json` for a person to send; sends nothing |
| `eucleia_send_email` | **block** | Listed so agents see the refusal. Eucleia never sends email. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `eucleia-of-outreach approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`eucleia-of-outreach kill`).

Only `eucleia_add_suppression` can go on Auto (`--mode auto --auto eucleia_add_suppression`), so opt-outs are honoured without waiting. Releasing a batch is `binding_send`: it stays **one-click even in Auto**, and sending stays **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
eucleia-of-outreach tools
eucleia-of-outreach call eucleia_check_batch '{"drafts":"drafts.csv","suppression":"suppression.csv","config":"eucleia.json"}'
eucleia-of-outreach eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not an email sender, ESP or CRM. It has no mail credentials and sends nothing.
- Not legal advice, and passing the checks does not make a campaign compliant with CAN-SPAM, GDPR, CASL or any other law. It checks the fields and rules listed above.
- It does not verify that addresses exist or that you have consent to contact them.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/eucleia-of-outreach>
