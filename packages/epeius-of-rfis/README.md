# Epeius of RFIs (`epeius-of-rfis`)

> Reviews a construction RFI and submittal log against your drawing and spec index, and drafts RFIs that cite only the documents you provide. Sending to the architect or GC is one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Epeius your document index (`doc_id, type, title, revision, issued, status, file`, where `file` is an optional text extract of the sheet notes or spec section), your RFI log and, optionally, your submittal log. It flags:
- **RFIs**: overdue responses (with days overdue and ball in court), no due date, no references, references not in the index, references to a superseded revision, unknown revisions, cost or schedule impact not stated, and possible duplicate questions;
- **submittals**: not submitted by the required date, with the reviewer past `review_days` (default 14), returned for revise-and-resubmit, and spec sections not in the index.

It also shows **who holds the ball**: for each party (from the RFI log's `ball_in_court` column and an optional `ball_in_court` column in the submittal log), open items in 0–7, 8–14, 15–30 and 31+ day buckets, how many are overdue and the oldest one, plus a **chase list** ordered by days overdue with a one-line reason per item. Give it last week's export of the RFI log and it lists what changed: new and closed RFIs, moved due dates, ball-in-court changes and RFIs that became overdue.

It writes `rfi-log-review.md` (with the ball-in-court table and chase list), `rfi-log.csv` and `submittal-log.csv` (blank next-action and owner columns), `ball-in-court.csv`, `rfi-due-dates.ics` (open RFI response dates and unsent submittals' required-by dates, with reminders) and, with a previous export, `rfi-log-diff.md`. The report's hash is recorded in the audit line.

**Drawing index from title blocks.** Point it at a folder of title-block text (one `.txt` per sheet, for example a PDF text export) and it reads the sheet number, title, revision table and issue date, compares them with your index and writes a proposed `documents.from-title-blocks.csv` (earlier revisions marked superseded) and `title-block-index.md`. It flags new sheets, sheets where your index is behind the title block, old prints, title and revision conflicts and files it could not read. Your index is not changed.

**Transmittals.** With approval it drafts `drafts/TR-<no>.md` listing the drawings and specs you name, each on its current revision with its issue date and the hash of its text extract. Anything not in the index is `[MISSING REFERENCE]`; an old revision is `[CHECK REVISION]`. Sending it goes through the same one-click send request as an RFI. With approval it drafts an RFI from **your** subject and question: each reference is resolved to its current revision, and lines in the text extracts that mention your search terms are quoted with file and line number. Gaps are marked `[MISSING REFERENCE]`, `[CHECK REVISION]`, `[NO CITATION]` or `[TO CONFIRM]`, and a send request is refused while they remain unless a person accepts them with a note.

<!-- sources:start -->
## Exports it reads

Table inputs can be CSV, TSV, semicolon- or pipe-separated text, Excel `.xlsx`, JSON or JSONL. A file already in this agent's own columns is read as it is. The exports below are recognised by their column names and mapped onto those columns; dates become `YYYY-MM-DD`, amounts plain decimals (both decimal marks), and yes/no columns `yes`/`no`. Each result lists, under `sources`, which export was recognised, which columns were mapped, and any rows skipped or dates that could be read two ways.

**RFI log** (arguments `rfis`, `previous_rfis`)

| System | Export | Layout checked against vendor docs |
|---|---|---|
| Procore | RFIs > Export > CSV | support.procore.com "Export RFIs to CSV or PDF" on 2026-11-15 |

**Submittal log** (argument `submittals`)

No named exports: other column names are matched by a list of common alternatives.

**Drawing and specification register** (argument `documents`)

No named exports: other column names are matched by a list of common alternatives.

Columns named differently? Run `npx epeius-of-rfis inspect <file>` to see how a file is read (column names and shapes only, never values), then name your columns in `mythos-sources.json` in the root:

```json
{ "files": { "exports/users.csv": { "columns": { "email": "Work E-mail" }, "date_order": "dmy" } } }
```

Where a layout says "checked", its column names were compared with the vendor's documentation on that date. The other layouts were written from knowledge of the export and were not checked. None was tested against a live account. If a real export does not match, the result says which columns were missing; please report it.
<!-- sources:end -->

## Install

```bash
npm install -g epeius-of-rfis
epeius-of-rfis demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add epeius-of-rfis -- npx -y epeius-of-rfis@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "epeius-of-rfis": { "command": "npx", "args": ["-y", "epeius-of-rfis@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `epeius_review_log` | **allow** | Flags per RFI and submittal against the index |
| `epeius_write_log_report` | **allow** | Write `rfi-log-review.md`, `rfi-log.csv`, `submittal-log.csv`, `ball-in-court.csv`, `rfi-due-dates.ics` and (with `previous_rfis`) `rfi-log-diff.md` to `mythos-out/epeius` |
| `epeius_ball_in_court` | **allow** | Aging per responsible party and a chase list with reasons |
| `epeius_diff_logs` | **allow** | Compare an earlier RFI log export with the current one |
| `epeius_index_title_blocks` | **allow** | Read title-block text, compare with the index, write a proposed index (yours is not changed) |
| `epeius_draft_rfi` | **ask (Auto-eligible)** | Write `drafts/RFI-<no>.md` with file:line citations and open markers (not sent) |
| `epeius_draft_transmittal` | **ask (Auto-eligible)** | Write `drafts/TR-<no>.md` listing only indexed documents on their current revisions (not sent) |
| `epeius_request_send` | **ask · one-click** | After a named human approves, record the RFI or transmittal draft (bound to its hash and recipient) for whoever sends |
| `send_email` | **block** | Listed so agents see the refusal. Epeius never sends. |
| `project_portal_submit` | **block** | Listed so agents see the refusal. Epeius never submits to a project portal. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

### MCP prompt

`epeius_weekly_rfi_review` (arguments `documents`, `rfis`, `as_of`, optional `submittals`, `previous_rfis`, `title_blocks`) walks the host model through the weekly review: title blocks, log review, ball in court, week-over-week diff, the written report, drafting only on request, and the one-click send.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `epeius-of-rfis approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`epeius-of-rfis kill`).

`epeius_draft_rfi` and `epeius_draft_transmittal` can go on Auto, so Auto only pre-stages. Sending an RFI is a `binding_send`: it stays **one-click even in Auto**, and `--auto epeius_request_send` is refused. Email and project-portal submission stay **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
epeius-of-rfis tools
epeius-of-rfis call epeius_review_log '{"documents":"documents.csv","rfis":"rfis.csv","submittals":"submittals.csv","as_of":"2026-11-14"}'
epeius-of-rfis eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not design, engineering or legal advice. It does not interpret drawings or decide who is responsible for a cost.
- It cites only the index and text extracts you give it. It does not read PDFs or drawings, and a citation is only as good as the extract.
- Title-block reading is pattern matching on the text you export (labels like `SHEET NO`, `SHEET TITLE`, `REVISION` and a revision table of `rev date description` lines). It does no OCR; a title block it cannot read is reported, not guessed.
- Aging counts calendar days. A submittal's party comes from its `ball_in_court` column when present; otherwise it is assumed to be the reviewer while submitted and the contractor while unsent or returned.
- Not a project management system. It does not replace your RFI log of record.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/epeius-of-rfis>
