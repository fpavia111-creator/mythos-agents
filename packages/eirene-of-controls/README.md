# Eirene of Controls (`eirene-of-controls`)

> Turn agent guardrail logs into an evidence folder a reviewer can read. Evidence, not certification.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Eirene reads JSONL audit logs from **Talos** (`.agent-guard/audit.jsonl`) and from any **mythos-agent-core** pack (`.mythos/audit.jsonl`), plus optional **Alethea** decision records (`.decisions/*.md`). It:
- verifies each log's hash chain and names edited, removed or reordered lines;
- verifies **Ed25519 signatures** on signed mythos-agent-core logs when you give it the public key (`public_keys`), following signed key rotations recorded in the log. A log that was edited and re-chained passes a chain-only check but fails here, with the line number;
- summarizes what was allowed, what waited for a person, who approved it, what ran on Auto and what was blocked;
- maps log events **and evidence files** (access reviews, change logs, drill notes…) to **your own** control ids. Every evidence item in `control-evidence.csv` cites a control id; controls with no evidence are listed as **gaps**; controls whose latest dated evidence is older than their `frequency` allows (measured at `as_of`, or `period_end`) are **stale**; events that map to no control are counted;
- diffs two evidence folders (e.g. last quarter vs this quarter) by path and SHA-256: added, removed, changed, unchanged, and files carried over under a new name;
- writes an evidence folder: `README.md`, `index.html` (self-contained, no scripts), `events.csv` (with `control_ids`), `approvals.csv`, `blocked.csv`, `chain-verification.json` (chain and signing status), and when relevant `control-map.csv`, `control-evidence.csv`, `gaps.csv`, `evidence-files.csv`, `evidence-diff.csv`, `alethea-decisions.csv`, plus `MANIFEST.sha256`. The manifest's hash is returned as `output_sha256` and written into the audit line (signed when the agent runs with `--signing-key`).

### Your control list (`controls`)

Either the 0.1 array form or an object with a name:

```json
{ "name": "Our ITGC list", "controls": [
  { "id": "AC-01", "title": "User access is reviewed", "evidence_files": ["**/access-review*"], "frequency": "quarterly", "owner": "IT lead" },
  { "id": "AG-01", "title": "Destructive agent actions are blocked", "match": { "status": "blocked" } },
  { "id": "CM-01", "title": "Changes are approved", "match_any": [ { "decision": "ask", "status": "executed" }, { "tool": "*_report" } ] }
] }
```

`match` fields: `agent`, `tool`, `kind`, `category`, `mode`, `decision`, `status`, `approved_by`, `reason`, `file`, `detail`; values are exact text, `*`, or a glob (`augeas_*`, `?*` = not blank). `evidence_files` globs are relative to `evidence_dir` (a pattern without `/` matches the file name). Freshness uses a `YYYY-MM-DD` date in the event or the file name; undated files count as evidence but are not checked for freshness. Typos fail with a JSON pointer: `eirene-of-controls validate-config controls controls.json`.

Two starter lists ship in `templates/` (`agent-guardrails`, `itgc-starter`); use `"template": "itgc-starter"` instead of a file. Their ids are placeholders to rename to your own list. They are not official framework mappings, and evidence that matches a control does not show the control works.

### Signed logs

Start your agents with `--signing-key /outside/root/private.pem` (make one with `<agent> keygen --out DIR`, outside `--root`). Give Eirene only the **public** key (`public_keys: ["keys/audit-public.pem"]`). With a key given, every mythos-format log in that call must be signed: an unsigned or signature-stripped log fails rather than passing as "chained". Talos logs are chain-checked only. Logs without signatures still verify as "chained, unsigned".

## Install

```bash
npm install -g eirene-of-controls
eirene-of-controls demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add eirene-of-controls -- npx -y eirene-of-controls@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "eirene-of-controls": { "command": "npx", "args": ["-y", "eirene-of-controls@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `eirene_summarize_logs` | **allow** | Counts by decision, status, agent, tool; approvers |
| `eirene_verify_chain` | **allow** | Verify a Talos or mythos log's hash chain, and signatures with `public_keys` |
| `eirene_list_templates` | **allow** | List or show the starter control lists |
| `eirene_map_controls` | **allow** | Map events and evidence files to your controls; gaps, stale, unmapped |
| `eirene_diff_evidence` | **allow** | Diff two evidence folders by path and SHA-256 |
| `eirene_build_evidence` | **allow** | Write the evidence folder to `mythos-out/eirene` |
| `eirene_send_to_auditor` | **block** | Listed so agents see the refusal. A person reviews and shares the folder. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

The MCP prompt `eirene_evidence_review` walks a host model through verify → summarize → map → diff → build, and stops at the human sharing step.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `eirene-of-controls approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`eirene-of-controls kill`).

All tools are read or report. Sending evidence is `binding_send`, which is one-click by rule and **blocked** in this pack.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
eirene-of-controls tools
eirene-of-controls call eirene_build_evidence '{"logs":[".agent-guard/audit.jsonl",".mythos/audit.jsonl"],"controls":"controls.json","period_start":"2026-10-01","period_end":"2026-10-31"}'
eirene-of-controls eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not an audit opinion, a certification, or proof of compliance with SOC 2, ISO 27001 or any other framework.
- It shows only what the logs recorded. Actions outside the logged tools are invisible to it.
- A verified chain shows lines were not edited one by one. Without signatures it cannot rule out a whole-file rewrite; verified signatures show the lines were written by the holder of the signing key. Neither proves the log is complete.
- Matching evidence to a control is not a test of that control. The starter templates are not official framework mappings.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/eirene-of-controls>
