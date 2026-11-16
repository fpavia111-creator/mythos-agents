# Ladon of Access (`ladon-of-access`)

> Access recertification for people, AI agents and service accounts. A named human decides. Never revokes by itself.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Ladon an access export (one row per account per system: `system, user, email, account_type, role, owner, last_login, status, mfa`, optionally `last_rotated` for agent and service credentials) and, optionally, an HR roster (`email, status, termination_date, manager`). Column names are matched loosely. It flags:
- people marked terminated in HR, or missing from the roster;
- stale (default 90 days) and never-used logins;
- privileged roles (Administrator, Full Access, Super Admin, Payments Admin… or your own list), and privileged accounts without MFA;
- **agents and service accounts with no owner**, and, when the export has a rotation column, with no credential rotation date or one older than 90 days;
- segregation-of-duties conflicts you define (for example "Payments Admin" in one system and "A/P Clerk" in another for the same person);
- shared/generic and duplicate accounts.

Every flag comes with a plain-language reason. Then it writes a recertification sheet: each line gets an `assigned_reviewer` (the account owner, else the person's manager from the roster), a `delegated_to` reviewer if you set up a delegation, a `due_date` (14 days by default, half that for high risk), and blank `reviewer_decision`, `reviewer_name` and `review_date` columns for the reviewer to fill in.

When the sheet comes back, Ladon reports campaign progress (overdue lines, missing sign-offs, self-reviews, lines signed by someone other than the assigned reviewer, a chase list per reviewer) and writes an evidence pack (JSON + self-contained HTML, with the sheet's sha256; the pack's hash is written into the audit log). It can also compare two exports to show what changed since the last review: privilege gained, new agents, reactivated and removed accounts, owner changes.

### Review policy file

Optional `ladon-policy` JSON (unknown keys and wrong types are refused with a JSON-pointer error; check one with `ladon-of-access validate-config ladon-policy <file>`):

```json
{
  "stale_days": 90, "due_days": 14, "rotation_max_days": 90,
  "privileged_roles": ["Administrator", "Payments Admin"],
  "delegations": [{ "from": "Avery Stone", "to": "Kim Ortiz", "reason": "on leave" }],
  "sod_rules": [{ "name": "payments-vs-payables", "roles_a": ["Payments Admin"], "roles_b": ["A/P Clerk"] }]
}
```

Arguments passed to a tool override the file.

<!-- sources:start -->
## Exports it reads

Table inputs can be CSV, TSV, semicolon- or pipe-separated text, Excel `.xlsx`, JSON or JSONL. A file already in this agent's own columns is read as it is. The exports below are recognised by their column names and mapped onto those columns; dates become `YYYY-MM-DD`, amounts plain decimals (both decimal marks), and yes/no columns `yes`/`no`. Each result lists, under `sources`, which export was recognised, which columns were mapped, and any rows skipped or dates that could be read two ways.

**Account and access export** (arguments `access`, `previous`, `current`)

| System | Export | Layout checked against vendor docs |
|---|---|---|
| Okta | Users API JSON (GET /api/v1/users) | no |
| Microsoft Entra ID | Users > Download users (CSV) | no |
| Microsoft 365 admin center | Active users > Export users (CSV) | no |
| Google Workspace Admin | Users > Download users (CSV) | no |
| Slack | Manage members > Export member list (CSV) | no |
| GitHub | Organization People > Export (CSV or JSON) | no |
| AWS IAM | Credential report (CSV) | no |
| Atlassian Administration | Directory > Users > Export users (CSV) | no |

**HR roster** (argument `roster`)

| System | Export | Layout checked against vendor docs |
|---|---|---|
| BambooHR | Employee report (CSV or Excel) | no |

Columns named differently? Run `npx ladon-of-access inspect <file>` to see how a file is read (column names and shapes only, never values), then name your columns in `mythos-sources.json` in the root:

```json
{ "files": { "exports/users.csv": { "columns": { "email": "Work E-mail" }, "date_order": "dmy" } } }
```

Where a layout says "checked", its column names were compared with the vendor's documentation on that date. The other layouts were written from knowledge of the export and were not checked. None was tested against a live account. If a real export does not match, the result says which columns were missing; please report it.
<!-- sources:end -->

### Exports and summaries in other languages

Ladon reads access exports and HR rosters with column names in German, French, Spanish, Portuguese, Italian, Japanese, Chinese or Korean (`ユーザー`, `権限`, `最終ログイン`, `Benutzer`, `Rolle`...), in legacy encodings such as Shift_JIS. Admin and owner roles (`管理者`, `관리자`, `Administrateur`...), disabled and deleted statuses (`無効`, `gesperrt`, `desativado`...), leavers (`退職`, `ausgeschieden`...) and "no" in an MFA column (`いいえ`, `아니요`, `nein`...) are recognised. Role names in policy files and learned roles can be written in any script.

`recertification-summary.md` and the evidence page can be written in those languages: pass `"language": "de"` (or `--lang de`). `recertification.csv`, the flag codes, the decision words (keep / modify / revoke) and the evidence JSON stay in English, and the evidence hash is the same in every language. A translated page says it is a Claude translation that a native speaker has not reviewed yet.

## Install

```bash
npm install -g ladon-of-access
ladon-of-access demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add ladon-of-access -- npx -y ladon-of-access@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "ladon-of-access": { "command": "npx", "args": ["-y", "ladon-of-access@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `ladon_review_access` | **allow** | Flag risky accounts, highest risk first |
| `ladon_recert_sheet` | **allow** | Write `recertification.csv` (reviewers, delegations, due dates) + summary to `mythos-out/ladon` |
| `ladon_access_diff` | **allow** | Compare a previous and a current export; review-first list of changes |
| `ladon_campaign_status` | **allow** | Progress of a filled sheet: overdue, incomplete, self-review, chase list, revoke decisions |
| `ladon_evidence_pack` | **allow** | Write `recertification-evidence.json/.html` to `mythos-out/ladon/evidence`; hash logged as `output_sha256` |
| `ladon_request_revocation` | **ask · one-click** | After a named human approves, append a request to `revocation-requests.csv` for the system admin |
| `ladon_recall` | **allow** | Search what Ladon has learned about this customer: accepted facts and facts waiting for a person |
| `ladon_learn` | **allow** | Propose a fact to remember (extra privileged role, SoD rule, standing delegation, note). Stored as waiting; changes nothing |
| `ladon_accept_learning` | **ask · one-click** | A named person accepts or rejects a waiting fact (`accept_learning`, never on Auto) |
| `ladon_retire_memory` | **ask · one-click** | A named person stops an accepted fact; the history stays |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Memory: what Ladon remembers about your setup

Ladon can remember facts about one customer's access setup, so the next quarterly review does not have to be told again. It only remembers what a named person accepts, and every kind it can learn **adds** to a check:

| Kind | Example | What an accepted fact changes |
|---|---|---|
| `privileged_role` | `{"role": "Vault Keeper"}` | Adds the role to the privileged list in every review and diff (built-in, policy and argument lists stay as they are). MFA is then checked for it, and a move into it counts as privilege gained. |
| `sod_rule` | `{"name": "vendor-vs-payment", "roles_a": ["Vendor Master"], "roles_b": ["Payment Release"]}` | Adds the rule to the segregation-of-duties check. A policy-file rule with the same name wins. |
| `delegation` | `{"from": "Ana Ruiz", "to": "Ben Ode", "reason": "on leave"}` | Fills `delegated_to` for lines assigned to "from", unless the policy file delegates for that person. A delegation to oneself is ignored. |
| `note` | `{"text": "Okta export is pulled on the 1st"}` | Nothing. Shown by recall only. |

Ladon cannot learn a longer stale period, a shorter list of roles, a removed rule, or anything about policy, caps or Auto.

```bash
ladon-of-access call ladon_learn '{"kind":"privileged_role","value":{"role":"Vault Keeper"},"note":"Can release payments"}'
ladon-of-access memory list
ladon-of-access memory accept MEM-1a2b3c4d5e6f --as "Your Name" --reason "Confirmed with IT"
ladon-of-access memory verify
```

Accepted facts are applied from the next call. Each result lists them under `memory` (and `memory_applied`), lines privileged only by a learned role say so in `reasons` and `privileged_by`, and the recertification summary has a "Learned facts used" section. Memory lives in `.mythos/memory/ladon-of-access.jsonl`, hash-chained (and signed with `--signing-key`); if it does not verify, no learned fact is used. `--no-memory` runs without it. Ladon refuses to store passwords, keys, personal identifiers and text that reads like instructions to an AI.

## MCP prompt

`ladon_recertification_campaign` (arguments: `access`, `as_of`, optional `roster`, `policy`, `previous`) walks a host model through the whole campaign: recall what Ladon has learned, review, diff, sheet, status, evidence pack, and revocation requests that wait for a person's click.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `ladon-of-access approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`ladon-of-access kill`).

Revoking access is `revoke_access`: it stays **one-click even in Auto**, and `--auto ladon_request_revocation` is refused. Accepting or retiring a learned fact is `accept_learning`, also one-click: `--auto ladon_accept_learning` is refused. Auto still runs the reviews and sheets without stopping.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
ladon-of-access tools
ladon-of-access call ladon_review_access '{"access":"access-export.csv","roster":"hr-roster.csv","stale_days":90}'
ladon-of-access eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not an identity provider or IGA platform. It does not connect to any system and does not remove access; an admin does that.
- `suggested_action` is a hint. The reviewer's decision is the decision.
- The sheet supports a review. On its own it is not evidence that a review happened. The evidence pack records what the sheet says; it does not prove that the reviews took place, and it is not an audit opinion or a certification.
- No IdP connectors (Okta, Entra) yet: it works on exports you provide.
- Segregation-of-duties checks only cover the rules you write; there is no built-in rule library.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/ladon-of-access>
