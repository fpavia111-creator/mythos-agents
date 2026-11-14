# Epeius of RFIs (`epeius-of-rfis`)

> Reviews a construction RFI and submittal log against your drawing and spec index, and drafts RFIs that cite only the documents you provide. Sending to the architect or GC is one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Epeius your document index (`doc_id, type, title, revision, issued, status, file`, where `file` is an optional text extract of the sheet notes or spec section), your RFI log and, optionally, your submittal log. It flags:
- **RFIs**: overdue responses (with days overdue and ball in court), no due date, no references, references not in the index, references to a superseded revision, unknown revisions, cost or schedule impact not stated, and possible duplicate questions;
- **submittals**: not submitted by the required date, with the reviewer past `review_days` (default 14), returned for revise-and-resubmit, and spec sections not in the index.

It writes `rfi-log-review.md`, `rfi-log.csv` and `submittal-log.csv` (blank next-action and owner columns). With approval it drafts an RFI from **your** subject and question: each reference is resolved to its current revision, and lines in the text extracts that mention your search terms are quoted with file and line number. Gaps are marked `[MISSING REFERENCE]`, `[CHECK REVISION]`, `[NO CITATION]` or `[TO CONFIRM]`, and a send request is refused while they remain unless a person accepts them with a note.

## Install

```bash
npm install -g epeius-of-rfis
epeius-of-rfis demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add epeius-of-rfis -- npx -y epeius-of-rfis@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "epeius-of-rfis": { "command": "npx", "args": ["-y", "epeius-of-rfis@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `epeius_review_log` | **allow** | Flags per RFI and submittal against the index |
| `epeius_write_log_report` | **allow** | Write `rfi-log-review.md`, `rfi-log.csv`, `submittal-log.csv` to `mythos-out/epeius` |
| `epeius_draft_rfi` | **ask (Auto-eligible)** | Write `drafts/RFI-<no>.md` with file:line citations and open markers (not sent) |
| `epeius_request_send` | **ask · one-click** | After a named human approves, record the draft (bound to its hash and recipient) for whoever sends |
| `send_email` | **block** | Listed so agents see the refusal. Epeius never sends. |
| `project_portal_submit` | **block** | Listed so agents see the refusal. Epeius never submits to a project portal. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `epeius-of-rfis approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`epeius-of-rfis kill`).

`epeius_draft_rfi` can go on Auto, so Auto only pre-stages. Sending an RFI is a `binding_send`: it stays **one-click even in Auto**, and `--auto epeius_request_send` is refused. Email and project-portal submission stay **blocked**.

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
- Not a project management system. It does not replace your RFI log of record.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/epeius-of-rfis>
