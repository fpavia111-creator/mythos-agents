# Auxo of Vendors (`auxo-of-vendors`)

> Vendor W-9 readiness from CSV exports: what is missing, what needs fixing and who to ask, with request drafts. Sending is one human click. It never files with the IRS and is not tax advice.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Auxo a vendor export (`vendor_id, name, legal_name, entity_type, country, tin, w9_received, w9_signed, address, email, requested_date`) and, optionally, payments (`vendor_id, date, amount, method`). For each vendor it reports:
- a status: `ready`, `request_w9`, `fix_details` (unsigned form, missing or badly formatted TIN, LLC classification missing), `review` (form older than `refresh_years`, default 3) or `ask_preparer` (non-US vendor: a W-8 form may apply instead);
- the TIN **masked** (`•••••1234`). Full TINs are never returned, written or logged;
- payments for the year by non-card methods, with card and payment-app amounts listed separately, against a threshold. The default is 600 for payments before 2026 and 2000 for 2026. For later years the figure is inflation-adjusted, so Auxo marks it unconfirmed until you pass `threshold`;
- a priority (high if over the threshold and not ready) and whether a first request or a reminder is due (`remind_days`, default 7).

It writes `w9-tracker.csv` (blank owner and follow-up columns) and `readiness.md`, and drafts request or reminder emails marked DRAFT. The drafts ask vendors to use your secure upload link rather than email a TIN.

## Install

```bash
npm install -g auxo-of-vendors
auxo-of-vendors demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add auxo-of-vendors -- npx -y auxo-of-vendors@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "auxo-of-vendors": { "command": "npx", "args": ["-y", "auxo-of-vendors@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `auxo_check` | **allow** | Status, flags, masked TIN, payment totals and priority per vendor |
| `auxo_write_tracker` | **allow** | Write `w9-tracker.csv` and `readiness.md` to `mythos-out/auxo` |
| `auxo_draft_requests` | **ask (Auto-eligible)** | Write request and reminder drafts to `mythos-out/auxo/requests` (not sent) |
| `auxo_request_send` | **ask · one-click** | After a named human approves, record a draft as approved to send |
| `irs_efile` | **block** | Listed so agents see the refusal. Auxo never files with the IRS. |
| `send_email` | **block** | Listed so agents see the refusal. Auxo never sends. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `auxo-of-vendors approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`auxo-of-vendors kill`).

`auxo_draft_requests` can go on Auto. Sending a request to a vendor is a `binding_send`: it stays **one-click even in Auto**, and `--auto auxo_request_send` is refused. E-filing and sending stay **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
auxo-of-vendors tools
auxo-of-vendors call auxo_check '{"vendors":"vendors.csv","payments":"payments.csv","year":2026}'
auxo-of-vendors eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not tax advice. It does not decide who is reportable, which form applies, or how card payments are treated; your preparer does.
- Not a filing product. It never files information returns with the IRS or any agency, and it does not validate TINs with the IRS (TIN matching).
- US W-9 focused. For non-US vendors it only says to ask your preparer.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/auxo-of-vendors>
