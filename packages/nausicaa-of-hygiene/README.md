# Nausicaa of Hygiene (`nausicaa-of-hygiene`)

> CRM and contact-list hygiene from exports: bounces, role and disposable addresses, duplicates, stale records and consent flags. Bulk deletes are one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Nausicaa a contact export (`id, email, name, company, last_activity, bounce, consent, consent_date, unsubscribed, status`; names matched loosely) and, optionally, a suppression list. It flags:
- invalid emails and common domain typos (`gmial.com` → `gmail.com`);
- hard and soft bounces; addresses or domains on your suppression list;
- role addresses (`info@`, `sales@`, `noreply@`…) and a short list of disposable domains;
- duplicates (case, `+tags`, and Gmail dots ignored);
- records with no activity for `stale_days` (default 365);
- consent missing, refused, older than `reconsent_days` (default 730), or contradicted by an unsubscribe.

Each contact gets a suggested action: keep, fix, merge, suppress, re-permission, review or delete candidate. It writes a review sheet, a suppression-additions list, and (with approval) a copy of the export with `do_not_email` marked. Rows are never removed.

It also:
- gives the list a **health score** (0-100) with every deduction explained: weight × share of contacts affected, per area (deliverability, consent, duplicates, engagement, role addresses). A summary of the export, not a deliverability prediction;
- writes a **merge plan** for duplicates: a survivor chosen by stated rules (not hard-bounced, most recent activity, most complete, earliest row) and a winner per field with the rule that picked it. Opt-outs and hard bounces on any duplicate always carry over;
- checks **consent provenance**: opted-in or subscribed contacts with no consent source, no date, an unreadable or future date, or a source not on your allowed list;
- **compares** this export with the previous one: health change, contacts added and removed, newly flagged (new bounces, unsubscribes, duplicates), resolved issues and action changes;
- with your opt-in, checks that each email **domain can receive mail** (MX, A fallback, null MX). See "MX check" below.

<!-- sources:start -->
## Exports it reads

Table inputs can be CSV, TSV, semicolon- or pipe-separated text, Excel `.xlsx`, JSON or JSONL. A file already in this agent's own columns is read as it is. The exports below are recognised by their column names and mapped onto those columns; dates become `YYYY-MM-DD`, amounts plain decimals (both decimal marks), and yes/no columns `yes`/`no`. Each result lists, under `sources`, which export was recognised, which columns were mapped, and any rows skipped or dates that could be read two ways.

**Contact list** (arguments `contacts`, `previous`)

| System | Export | Layout checked against vendor docs |
|---|---|---|
| HubSpot | Contacts > Export (CSV or Excel) | no |
| Salesforce | Contacts or Leads report export | no |
| Salesforce | Data Loader / Data Export of Contact (API field names) | no |
| Mailchimp | Audience > Export audience (CSV) | no |

Columns named differently? Run `npx nausicaa-of-hygiene inspect <file>` to see how a file is read (column names and shapes only, never values), then name your columns in `mythos-sources.json` in the root:

```json
{ "files": { "exports/users.csv": { "columns": { "email": "Work E-mail" }, "date_order": "dmy" } } }
```

Where a layout says "checked", its column names were compared with the vendor's documentation on that date. The other layouts were written from knowledge of the export and were not checked. None was tested against a live account. If a real export does not match, the result says which columns were missing; please report it.
<!-- sources:end -->

### Lists from other markets

Consent, status and bounce values are read in English, German, French, Spanish, Portuguese, Italian, Japanese, Chinese and Korean: `ja` and `widerrufen`, `oui` and `désabonné`, `はい` and `配信停止`, `동의` and `수신거부`, `ハードバウンス`, `rebote temporal`. Role mailboxes in those languages (`kontakt@`, `ventas@`, `contato@`, `amministrazione@`, romanized `eigyo@`) count as role addresses. These are short word lists; a value Nausicaa does not know is left as unknown, never guessed. Nothing here is a statement about any country's consent rules.

## Install

```bash
npm install -g nausicaa-of-hygiene
nausicaa-of-hygiene demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add nausicaa-of-hygiene -- npx -y nausicaa-of-hygiene@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "nausicaa-of-hygiene": { "command": "npx", "args": ["-y", "nausicaa-of-hygiene@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `nausicaa_audit` | **allow** | Flag every contact with a suggested action |
| `nausicaa_write_cleanup` | **allow** | Write `hygiene-review.csv` + `suppression-additions.csv` to `mythos-out/nausicaa` |
| `nausicaa_merge_plan` | **allow** | Survivor and field-level winners per duplicate group, rules explained; `merge-plan.csv` |
| `nausicaa_consent_provenance` | **allow** | Flag opted-in contacts with no consent source or date |
| `nausicaa_compare` | **allow** | Compare with the previous export: health change, new flags, added/removed |
| `nausicaa_check_mx` | **ask (Auto-eligible)** | Opt-in domain MX check from a saved records file or, with `allow_network:true`, a public DoH resolver; `mx-check.csv` |
| `nausicaa_write_clean_copy` | **ask (Auto-eligible)** | Write `<name>.clean.csv` with flags and `do_not_email`; every row kept |
| `nausicaa_request_bulk_delete` | **ask · one-click** | After a named human approves, record a delete list for the CRM admin |
| `crm_delete_contacts` | **block** | Listed so agents see the refusal. Nausicaa never deletes CRM records. |

CSV files are written so that a spreadsheet does not run cell text as a formula: a cell that starts with `=`, or with `+`, `-` or `@` in a way a spreadsheet would run as a formula, gets a leading apostrophe. Plain numbers, phone-style values and `@handles` are left as they are. If you import the file somewhere else, such a cell arrives with the apostrophe.

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

### MX check (opt-in, off by default)

`nausicaa_check_mx` is the only tool that can touch the network, and only when you ask:
- it needs a person's yes (or `--auto nausicaa_check_mx`) and is **blocked in review mode**;
- with `records` it reads a saved DNS records file and makes no network call;
- live lookups happen only with `allow_network: true`, go to one allowlisted DNS-over-HTTPS resolver (`cloudflare` by default, or `google`), and send **domain names only**, never email addresses;
- it checks at most `max_domains` domains (default 50).

It tells you whether a domain publishes a mail server. It does not check that a mailbox exists.

### Rules file (optional)

```json
{ "version": 1, "extra_role_locals": ["events"], "extra_disposable_domains": ["throwaway.example"], "typo_domains": { "exmaple.com": "example.com" }, "allowed_consent_sources": ["web form", "event"], "stale_days": 365, "reconsent_days": 730 }
```

Pass it as `rules`. It is checked against the `hygiene_rules` schema, so a typo fails with a JSON pointer: `nausicaa-of-hygiene validate-config hygiene_rules rules.json`.

### MCP prompt

`list_hygiene_workflow` walks the host model through audit, provenance, merge plan, comparison, the optional MX check, review files and bulk-delete requests (each waits for a named person).

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `nausicaa-of-hygiene approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`nausicaa-of-hygiene kill`).

`nausicaa_write_clean_copy` can go on Auto. Bulk deletes are `delete_personal_data`: they stay **one-click even in Auto**, and `--auto nausicaa_request_bulk_delete` is refused. Deleting in the CRM stays **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
nausicaa-of-hygiene tools
nausicaa-of-hygiene call nausicaa_audit '{"contacts":"contacts.csv","suppression":"suppression.csv","stale_days":365}'
nausicaa-of-hygiene eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not an email verification service. It never connects to mail servers; the opt-in MX check reads DNS only. Role and disposable lists are short and built in (extend them in the rules file).
- Merge plans and health scores are suggestions from the exported columns; your CRM admin merges.
- Not a CRM. It reads an export and writes files; your CRM admin makes any change.
- Consent checks read the columns you export. They are not legal advice on what consent you need.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No telemetry. No network calls, except the opt-in live MX check described above. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/nausicaa-of-hygiene>
