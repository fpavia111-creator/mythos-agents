# Eos of Onboarding (`eos-of-onboarding`)

> Tracks onboarding checklists for new employees, contractors and customers, and drafts access requests once the prerequisites are done. Granting or removing access is one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Eos a people export (`person_id, name, type, role, manager, start_date, end_date`), a checklist template as JSON (tasks per type, each with `kind`, `owner`, `due_offset_days` from the start date, and `requires` for tasks that must be done first) and a status export (`person_id, task_id, status, done_on, note`). It:
- gives each task a due date and a state: done, overdue, due soon, waiting on another task, blocked, ready or open;
- shows percent done and the next tasks per person, and flags people starting within `due_soon_days` (default 3) whose pre-start tasks are not done;
- flags access marked granted before its prerequisites (for example, before the NDA or SOW), contractors with access but no end date, access still marked granted after an engagement ended, and status rows for tasks not in the template;
- writes `onboarding-tracker.csv` (blank checked-by column) and `onboarding.md`, and with approval drafts an access request for each access task whose prerequisites are done, plus a removal draft where access outlived the engagement.

It also:
- applies **per-role templates**: a `roles` section adds or removes tasks for a role (for example, a copywriter gets a CMS account instead of the code repository). People whose role is not in the template are flagged `unknown_role` and get the base checklist; access marked granted that the role leaves out is flagged `access_outside_role`;
- builds an **offboarding mirror checklist** from the end date for people ending within `window_days` (default 14) or already ended with tasks open: every access marked granted becomes `remove-<task>`, every equipment task done becomes `return-<task>`, plus the template's `offboarding` tasks for the type. With approval it drafts removals (`eos_draft_offboarding`); recording a removal stays a separate one-click step;
- gives **each owner a prioritised action list** (IT, Ops, Finance, Manager…) across onboarding and offboarding, with the reason for each position: overdue access removals first, then overdue, blocked, day-one blockers, due soon, ready to request, open and waiting;
- writes a **day-one readiness report** (`readiness.html` and `readiness.json`) for people starting soon, listing exactly what blocks each person; the JSON hash goes into the audit log as `output_sha256`;
- adds `owner-actions.csv` and a calendar file (`onboarding-calendar.ics`, open tasks by due date) to the tracker.

The bundled templates are examples. Your checklist is yours to define.

<!-- sources:start -->
## Exports it reads

Table inputs can be CSV, TSV, semicolon- or pipe-separated text, Excel `.xlsx`, JSON or JSONL. A file already in this agent's own columns is read as it is. The exports below are recognised by their column names and mapped onto those columns; dates become `YYYY-MM-DD`, amounts plain decimals (both decimal marks), and yes/no columns `yes`/`no`. Each result lists, under `sources`, which export was recognised, which columns were mapped, and any rows skipped or dates that could be read two ways.

**People starting or leaving** (argument `people`)

| System | Export | Layout checked against vendor docs |
|---|---|---|
| BambooHR | Employee report (CSV or Excel) | no |

Columns named differently? Run `npx eos-of-onboarding inspect <file>` to see how a file is read (column names and shapes only, never values), then name your columns in `mythos-sources.json` in the root:

```json
{ "files": { "exports/users.csv": { "columns": { "email": "Work E-mail" }, "date_order": "dmy" } } }
```

Where a layout says "checked", its column names were compared with the vendor's documentation on that date. The other layouts were written from knowledge of the export and were not checked. None was tested against a live account. If a real export does not match, the result says which columns were missing; please report it.
<!-- sources:end -->

## Install

```bash
npm install -g eos-of-onboarding
eos-of-onboarding demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add eos-of-onboarding -- npx -y eos-of-onboarding@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "eos-of-onboarding": { "command": "npx", "args": ["-y", "eos-of-onboarding@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `eos_status` | **allow** | Task states, percent done, next tasks and flags per person |
| `eos_write_tracker` | **allow** | Write `onboarding-tracker.csv`, `onboarding.md`, `owner-actions.csv` and `onboarding-calendar.ics` to `mythos-out/eos` |
| `eos_offboarding` | **allow** | Offboarding mirror checklist (removals, returns, template tasks) from the end date |
| `eos_owner_actions` | **allow** | Prioritised open actions per owner, each with its reason |
| `eos_readiness_report` | **allow** | Day-one readiness HTML + JSON (hash in the audit log) |
| `eos_draft_offboarding` | **ask (Auto-eligible)** | Write offboarding checklists and removal drafts to `mythos-out/eos/offboarding` (not submitted) |
| `eos_draft_access_requests` | **ask (Auto-eligible)** | Write grant and removal drafts to `mythos-out/eos/access-requests` (not submitted) |
| `eos_request_access_grant` | **ask · one-click** | After a named human approves, re-check prerequisites and record the grant for IT |
| `eos_request_access_removal` | **ask · one-click** | After a named human approves, record the removal for IT |
| `idp_grant_access` | **block** | Listed so agents see the refusal. Eos never grants access. |
| `idp_remove_access` | **block** | Listed so agents see the refusal. Eos never removes access. |
| `send_email` | **block** | Listed so agents see the refusal. Eos never sends. |

Any other tool name is blocked. MCP hosts also get the prompt `run_onboarding`, which walks a model through onboarding and offboarding and stops for each human click. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `eos-of-onboarding approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`eos-of-onboarding kill`).

`eos_draft_access_requests` and `eos_draft_offboarding` can go on Auto. Mythos core has no separate "grant access" category, so Eos files granting under `go_live` (an account going live) and removing under `revoke_access`: both stay **one-click even in Auto**, and `--auto` on them is refused. A grant is refused even after approval if a prerequisite is not done. Identity-provider writes and email stay **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
eos-of-onboarding tools
eos-of-onboarding call eos_status '{"people":"people.csv","template":"template.json","status":"status.csv","as_of":"2026-11-14"}'
eos-of-onboarding eval          # private evals on the bundled fixtures
eos-of-onboarding validate-config template template.json   # typos fail with JSON pointers
```

The template is checked against a JSON Schema before every run: unknown keys (`"requries"`), wrong types, unknown task kinds and a missing `types` fail with the JSON pointer of the problem.

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not an HR, payroll or identity system, and it makes no identity-provider writes.
- Not HR, employment or legal advice. It tracks the checklist you write; it does not say what a law requires of you.
- It sees only the status you export, so a task done but not recorded shows as open.
- No HRIS connection in this version: it reads the people export you give it.
- The offboarding mirror covers access on the person's checklist. Access flagged `access_outside_role` (granted but not in the role) is flagged, not mirrored: check it by hand.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/eos-of-onboarding>
