# Aegle of Certificates (`aegle-of-certificates`)

> Expiry tracking for TLS certificates, domains, licences and vendor certificates of insurance, with chase-email drafts. Paid renewals, production changes and sends are one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Aegle an inventory CSV (`id, type, name, holder, issuer, expires, auto_renew, renewal_cost, owner, key_type, key_bits, signature, registrar_lock`; names matched loosely) and, if you track vendor insurance, a COI CSV (`vendor, coverage, limit, expires, additional_insured, certificate_id`) plus your own written requirement list (`coverage, min_limit, additional_insured`). It:
- sorts everything by days left: expired, critical (≤ 14 days), warning (≤ 30), upcoming (≤ 90), ok; thresholds are settable;
- flags TLS certificates with weak keys (RSA < 2048, EC < 256), SHA-1/MD5 signatures or a self-signed issuer, domains with auto-renew or registrar lock off, and items with no owner or no expiry date;
- says what each item needs next: a confirmation that auto-renew worked, a paid renewal, or a production change to install a new certificate;
- checks each vendor's COIs against your requirements: missing coverage, limit below the minimum, additional insured missing, expired or expiring;
- writes `expiry-report.md`, `expiry.csv` (blank reviewer columns) and `renewals.ics` (calendar reminders 30 days ahead), and drafts one chase email per vendor with gaps, marked DRAFT.

Aegle reads the files you export. It does not scan your servers or query registrars.

## Install

```bash
npm install -g aegle-of-certificates
aegle-of-certificates demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add aegle-of-certificates -- npx -y aegle-of-certificates@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "aegle-of-certificates": { "command": "npx", "args": ["-y", "aegle-of-certificates@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `aegle_scan` | **allow** | Days left, status, flags and next step per item; COI gaps per vendor |
| `aegle_write_report` | **allow** | Write `expiry-report.md`, `expiry.csv`, `renewals.ics` to `mythos-out/aegle` |
| `aegle_draft_chase` | **ask (Auto-eligible)** | Write chase email drafts to `mythos-out/aegle/chase-drafts` (not sent) |
| `aegle_request_chase_send` | **ask · one-click** | After a named human approves, record a draft as approved to send |
| `aegle_request_renewal` | **ask · one-click** | After a named human approves, record a paid renewal for whoever holds the card |
| `aegle_request_production_change` | **ask · one-click** | After a named human approves, record a certificate install or rotation for your change process |
| `purchase_renewal` | **block** | Listed so agents see the refusal. Aegle never pays. |
| `deploy_certificate` | **block** | Listed so agents see the refusal. Aegle never touches a server. |
| `send_email` | **block** | Listed so agents see the refusal. Aegle never sends. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `aegle-of-certificates approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`aegle-of-certificates kill`).

`aegle_draft_chase` can go on Auto. A vendor-facing send (`binding_send`), a renewal that costs money (`move_money`) and a production change (`production_deploy`) each stay **one-click even in Auto**; `--auto` on those tools is refused. Paying, deploying and sending stay **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
aegle-of-certificates tools
aegle-of-certificates call aegle_scan '{"certificates":"certificates.csv","cois":"cois.csv","requirements":"requirements.csv","warn_days":45}'
aegle-of-certificates eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not a certificate scanner or monitoring service. It checks the inventory you give it; keep that inventory current.
- Not a COI management platform, and not insurance or legal advice. It flags possible gaps against your written requirements; a person decides.
- It never buys, renews, installs or sends anything.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/aegle-of-certificates>
