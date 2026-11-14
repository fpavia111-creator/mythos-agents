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

## Install

```bash
npm install -g nausicaa-of-hygiene
nausicaa-of-hygiene demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add nausicaa-of-hygiene -- npx -y nausicaa-of-hygiene@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "nausicaa-of-hygiene": { "command": "npx", "args": ["-y", "nausicaa-of-hygiene@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `nausicaa_audit` | **allow** | Flag every contact with a suggested action |
| `nausicaa_write_cleanup` | **allow** | Write `hygiene-review.csv` + `suppression-additions.csv` to `mythos-out/nausicaa` |
| `nausicaa_write_clean_copy` | **ask (Auto-eligible)** | Write `<name>.clean.csv` with flags and `do_not_email`; every row kept |
| `nausicaa_request_bulk_delete` | **ask · one-click** | After a named human approves, record a delete list for the CRM admin |
| `crm_delete_contacts` | **block** | Listed so agents see the refusal. Nausicaa never deletes CRM records. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

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

- Not an email verification service. It does not ping mail servers; role and disposable lists are short and built in.
- Not a CRM. It reads an export and writes files; your CRM admin makes any change.
- Consent checks read the columns you export. They are not legal advice on what consent you need.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/nausicaa-of-hygiene>
