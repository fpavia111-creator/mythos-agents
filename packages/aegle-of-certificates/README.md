# Aegle of Certificates (`aegle-of-certificates`)

> Expiry tracking for TLS certificates, domains, licences and vendor certificates of insurance, with chase-email drafts. Paid renewals, production changes and sends are one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Aegle an inventory CSV (`id, type, name, holder, issuer, expires, auto_renew, renewal_cost, owner, key_type, key_bits, signature, registrar_lock`; names matched loosely) and, if you track vendor insurance, a COI CSV (`vendor, coverage, limit, expires, additional_insured, certificate_id`) plus your own written requirement list (`coverage, min_limit, additional_insured`). It:
- sorts everything by days left: expired, critical (≤ 14 days), warning (≤ 30), upcoming (≤ 90), ok; thresholds are settable;
- flags TLS certificates with weak keys (RSA < 2048, EC < 256), SHA-1/MD5 signatures or a self-signed issuer, domains with auto-renew or registrar lock off, and items with no owner or no expiry date;
- says what each item needs next: a confirmation that auto-renew worked, a paid renewal, or a production change to install a new certificate;
- checks each vendor's COIs against your requirements: missing coverage, limit below the minimum, additional insured missing, expired or expiring;
- checks each vendor against a **requirement profile** if you give one as JSON: a default list, per-category lists (for example a stricter list for electrical contractors) and a vendor→category map; it also checks **waiver of subrogation** when a requirement asks for it. The profile is schema-checked, so a typo fails with the exact JSON path (`aegle-of-certificates validate-config coi_requirements requirements.json`);
- **extracts COI fields from certificate text** (`aegle_extract_coi`): insured, coverages, limits, policy dates, additional insured, waiver of subrogation, from text exported from ACORD 25-style PDFs (for example `pdftotext -layout`). It does not read PDF files or images itself. It is pattern matching, so every row is marked `needs_review` with its source line and any warnings; a person checks it against the certificate before using it;
- **compares two inventory snapshots** (`aegle_diff_inventory`): renewed, added, removed, expiry moved earlier, auto-renew turned off, owner changed or removed, new weak-key flags, status worse — riskiest first;
- writes `expiry-report.md`, `expiry-report.html` (self-contained, no scripts), `expiry.csv` (blank reviewer columns) and `renewals.ics` (reminders at the warning and critical thresholds and one day before, or your own `reminder_days`), records the output hash in the audit line, and drafts one chase email per vendor with gaps, marked DRAFT;
- optionally runs a **live TLS check** (`aegle_tls_live_check`, see below).

Apart from the opt-in live TLS check, Aegle reads only the files you export. It does not query registrars or insurers.

### Live TLS check (opt-in, network)

`aegle_tls_live_check` is the only tool that touches the network. For each host you list (or each TLS row in your inventory with `from_inventory: true`, at most 25 per call) it opens one TLS handshake, reads the certificate the server presents and closes the connection. It sends no application data and changes nothing. It reports expiry, issuer, SAN, key, chain trust (`chain_untrusted`), `hostname_mismatch`, `self_signed`, and compares with your inventory (`inventory_mismatch` when the live expiry differs from your record, `not_in_inventory`). It writes `live-tls.csv`.

It is off by default: the policy is `ask`, so each call waits for a named person's yes (or an explicit `--auto aegle_tls_live_check` opt-in), and it is blocked in review mode. Its tests use an injected transport and a local TLS server with a throwaway self-signed certificate; they make no internet calls.

<!-- sources:start -->
## Exports it reads

Table inputs can be CSV, TSV, semicolon- or pipe-separated text, Excel `.xlsx`, JSON or JSONL. A file already in this agent's own columns is read as it is. The exports below are recognised by their column names and mapped onto those columns; dates become `YYYY-MM-DD`, amounts plain decimals (both decimal marks), and yes/no columns `yes`/`no`. Each result lists, under `sources`, which export was recognised, which columns were mapped, and any rows skipped or dates that could be read two ways.

**Certificates, domains and licences** (arguments `certificates`, `previous`)

| System | Export | Layout checked against vendor docs |
|---|---|---|
| AWS Certificate Manager | aws acm list-certificates JSON | no |
| crt.sh | Certificate search JSON (output=json) | no |

**Certificates of insurance** (argument `cois`)

No named exports: other column names are matched by a list of common alternatives.

Columns named differently? Run `npx aegle-of-certificates inspect <file>` to see how a file is read (column names and shapes only, never values), then name your columns in `mythos-sources.json` in the root:

```json
{ "files": { "exports/users.csv": { "columns": { "email": "Work E-mail" }, "date_order": "dmy" } } }
```

Where a layout says "checked", its column names were compared with the vendor's documentation on that date. The other layouts were written from knowledge of the export and were not checked. None was tested against a live account. If a real export does not match, the result says which columns were missing; please report it.
<!-- sources:end -->

## Install

```bash
npm install -g aegle-of-certificates
aegle-of-certificates demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add aegle-of-certificates -- npx -y aegle-of-certificates@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "aegle-of-certificates": { "command": "npx", "args": ["-y", "aegle-of-certificates@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `aegle_scan` | **allow** | Days left, status, flags and next step per item; COI gaps per vendor |
| `aegle_write_report` | **allow** | Write `expiry-report.md`, `expiry-report.html`, `expiry.csv`, `renewals.ics` to `mythos-out/aegle` (output hash in the audit line) |
| `aegle_diff_inventory` | **allow** | What changed between a previous and the current inventory export |
| `aegle_extract_coi` | **allow** | Extract COI rows from certificate text into `coi-extracted.csv`, every row `needs_review` |
| `aegle_tls_live_check` | **ask (Auto-eligible) · network** | Opt-in TLS handshake per listed host; writes `live-tls.csv`. Blocked in review mode |
| `aegle_draft_chase` | **ask (Auto-eligible)** | Write chase email drafts to `mythos-out/aegle/chase-drafts` (not sent) |
| `aegle_request_chase_send` | **ask · one-click** | After a named human approves, record a draft as approved to send |
| `aegle_request_renewal` | **ask · one-click** | After a named human approves, record a paid renewal for whoever holds the card |
| `aegle_request_production_change` | **ask · one-click** | After a named human approves, record a certificate install or rotation for your change process |
| `purchase_renewal` | **block** | Listed so agents see the refusal. Aegle never pays. |
| `deploy_certificate` | **block** | Listed so agents see the refusal. Aegle never touches a server. |
| `send_email` | **block** | Listed so agents see the refusal. Aegle never sends. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## MCP prompt

`aegle_renewal_review` (arguments `certificates`, optional `cois`, `requirements`, `previous`, `as_of`) walks a host model through the review: validate the profile, scan, diff, optional live check (after asking), COI text extraction, report, chase drafts, and the steps a person clicks.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `aegle-of-certificates approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`aegle-of-certificates kill`).

`aegle_draft_chase` and `aegle_tls_live_check` can go on Auto if you opt in. A vendor-facing send (`binding_send`), a renewal that costs money (`move_money`) and a production change (`production_deploy`) each stay **one-click even in Auto**; `--auto` on those tools is refused. Paying, deploying and sending stay **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
aegle-of-certificates tools
aegle-of-certificates call aegle_scan '{"certificates":"certificates.csv","cois":"cois.csv","requirements":"requirements.csv","warn_days":45}'
aegle-of-certificates eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not a certificate scanner or monitoring service. It does not discover certificates or run on a schedule; it checks the inventory you give it (and, if you ask, the hosts you list). Keep that inventory current.
- Not a PDF reader or OCR tool. COI extraction works on text you export, is pattern-based, and every value needs a person's check.
- Not a COI management platform, and not insurance or legal advice. It flags possible gaps against your written requirements; a person decides.
- It never buys, renews, installs or sends anything.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No telemetry. No network calls, except `aegle_tls_live_check` when a person approves it (or opts it in to Auto). The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/aegle-of-certificates>
