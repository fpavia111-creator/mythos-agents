# Solon of Clauses (`solon-of-clauses`)

> Checks a contract's text against your own clause playbook and gives you a cited gap list. Sending or signing is a legally binding send: sending is one human click after a named reviewer, and signing is blocked. Not legal advice.

> **Important: not legal advice.** Solon of Clauses is not legal advice and does not replace a lawyer. It gives no guarantee that its clause findings, statuses or citations are accurate or complete: it can miss a clause, flag the wrong one or misread a number. Have a qualified lawyer review any contract before you rely on it, send it or sign it.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

**Not legal advice, and not a substitute for a lawyer.** Solon is a checklist runner: it finds the words and numbers *your* playbook names and tells you where they are. It does not interpret clauses, weigh risk, or look after the other side's interests.

Give Solon a contract as a Word file (`.docx`) or plain text (`.txt` or `.md`) and your playbook, a JSON checklist written by you or your counsel. For each clause the playbook lists, you set the phrases that show it is there (`find`), whether it is required or prohibited, words it must or must not include, an optional number check (for example payment within at most 45 days, or a liability cap of at least 12 months of fees), your position note, and your own fallback wording. For each clause it reports:
- a status: **missing**, **prohibited_present**, **needs_attention** (expected words absent, forbidden words present, a number outside your limits, or a number it could not find), **present**, or absent and optional/acceptable;
- citations: section number and heading, line and a short quote;
- document checks: unfilled placeholders (`[●]`, `[TBD]`, `____`), references to sections that do not exist, and duplicate section numbers;
- defined terms: capitalised terms that are used but not defined, terms that are defined (`"Term" means ...` or `(the "Term")`) but not used anywhere else, and terms defined twice, each with its lines. This is pattern matching: it lists candidates for a person to read and will miss or over-report some. Put names it should skip in the playbook's `ignore_terms`.

**Word files.** A `.docx` is read directly with no extra software: one paragraph becomes one line, so citation "lines" are paragraph numbers. Tracked changes are read **as if accepted** (insertions kept, deletions dropped) and flagged with their counts; comments are counted but not read; paragraphs that use Word's automatic numbering are flagged, because those numbers are not in the text. Tables, footnotes, headers and text boxes may not come through.

**Comparing drafts.** `solon_compare_drafts` checks two drafts against the same playbook and shows, clause by clause, whether each status got better, worse or stayed the same (with the numbers before and after), which document and defined-term findings are new or resolved, and which sections changed.

**Playbook versions.** Give the playbook a `version` (and optionally `updated` and `owner`). Every memo cites the playbook version and the first 12 characters of the playbook file's SHA-256, so counsel can tell which checklist a memo was checked against. The playbook is checked against a schema before use: an unknown key or wrong type fails with the path to the problem (`solon-of-clauses validate-config playbook playbook.json`).

It writes `clause-gaps.md` and `clause-gaps.csv` (and, given a previous draft, `draft-changes.md` and `contract.diff`); the report's SHA-256 goes into the audit log. With approval it drafts `issues-for-counsel.md`: each gap with its citation, your playbook's position, and your fallback wording **copied word for word**. Solon writes no contract language of its own, and every section is marked `[COUNSEL REVIEW]`. Pass the earlier memo as `previous_draft` to also get `issues-for-counsel.diff`, a redline of the memo.

## Install

```bash
npm install -g solon-of-clauses
solon-of-clauses demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add solon-of-clauses -- npx -y solon-of-clauses@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "solon-of-clauses": { "command": "npx", "args": ["-y", "solon-of-clauses@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `solon_check` | **allow** | Status, citations and issues per playbook clause, plus document checks |
| `solon_write_report` | **allow** | Write `clause-gaps.md` and `clause-gaps.csv` to `mythos-out/solon` (plus `draft-changes.md` and `contract.diff` with `previous_contract`) |
| `solon_compare_drafts` | **allow** | Compare two drafts against the playbook: clauses better or worse, new and resolved findings, changed sections |
| `solon_draft_markup` | **ask (Auto-eligible)** | Draft `issues-for-counsel.md` from your playbook's own language, citing the playbook version, every section marked `[COUNSEL REVIEW]`; optional redline against the previous memo |
| `solon_request_send` | **ask · one-click** | After a named human approves, record the send (bound to the draft hash) once counsel is named and every `[COUNSEL REVIEW]` marker is cleared |
| `send_email` | **block** | Listed so agents see the refusal. Solon never sends. |
| `e_sign` | **block** | Listed so agents see the refusal. Solon never signs or accepts a contract. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `solon-of-clauses approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`solon-of-clauses kill`).

`solon_check`, `solon_compare_drafts` and `solon_draft_markup` can run on Auto. Sending marked-up clauses, a redline or any contract language is a `binding_send`: it stays **one-click even in Auto**, and `--auto solon_request_send` is refused. It also needs `reviewed_by` (the lawyer or authorised person who reviewed it) and is refused while any `[COUNSEL REVIEW]` marker remains. Counsel removes each marker after reviewing that section, which changes the hash, so the approval covers the reviewed text. Sending and signing stay **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
solon-of-clauses tools
solon-of-clauses call solon_check '{"contract":"contracts/msa.md","playbook":"playbook.json"}'
solon-of-clauses call solon_check '{"contract":"contracts/msa.docx","playbook":"playbook.json"}'
solon-of-clauses call solon_compare_drafts '{"contract":"contracts/msa-v2-tracked.docx","previous_contract":"contracts/msa.md","playbook":"playbook.json"}'
solon-of-clauses validate-config playbook playbook.json
solon-of-clauses eval          # private evals on the bundled fixtures
```

### MCP prompt

`contract_playbook_review` (arguments: `contract`, `playbook`, optional `previous_contract`) walks a host model through the check, the draft comparison, the report, the issues list, counsel's review and the one-click send. It tells the model to say this is not legal advice and never to tell anyone whether to sign.

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not legal advice, not a substitute for a lawyer, and not a contract review. It matches text against your checklist. A clause can match your words and still not do what you need, or do it in words your playbook did not list.
- It never reviews the other side's interests and never tells anyone whether to sign.
- `.docx`, `.txt` and `.md` only: export a `.pdf` or old `.doc` as text first. In a `.docx`, tracked changes are read as accepted, comments are not read, and tables, footnotes, headers and automatic numbering may not come through.
- The defined-terms check and the draft comparison are text matching. They can miss a term, report a name as a term, or call a clause "better" because a number moved inside your limit while other wording changed. A person reads the changes.
- It never sends, accepts or signs anything.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. Contracts are confidential, so keep the `--root` folder private. The bundled contract and playbook are fictional and are not a template or a recommendation.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/solon-of-clauses>
