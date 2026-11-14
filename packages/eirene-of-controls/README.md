# Eirene of Controls (`eirene-of-controls`)

> Turn agent guardrail logs into an evidence folder a reviewer can read. Evidence, not certification.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Eirene reads JSONL audit logs from **Talos** (`.agent-guard/audit.jsonl`) and from any **mythos-agent-core** pack (`.mythos/audit.jsonl`), plus optional **Alethea** decision records (`.decisions/*.md`). It:
- verifies each log's hash chain and names edited, removed or reordered lines;
- summarizes what was allowed, what waited for a person, who approved it, what ran on Auto and what was blocked;
- matches events to **your own** control ids (a small JSON file you write);
- writes an evidence folder: `README.md`, `events.csv`, `approvals.csv`, `blocked.csv`, `chain-verification.json`, optional `control-map.csv` and `alethea-decisions.csv`, and `MANIFEST.sha256`.

## Install

```bash
npm install -g eirene-of-controls
eirene-of-controls demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add eirene-of-controls -- npx -y eirene-of-controls@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "eirene-of-controls": { "command": "npx", "args": ["-y", "eirene-of-controls@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `eirene_summarize_logs` | **allow** | Counts by decision, status, agent, tool; approvers |
| `eirene_verify_chain` | **allow** | Verify a Talos or mythos log's hash chain |
| `eirene_build_evidence` | **allow** | Write the evidence folder to `mythos-out/eirene` |
| `eirene_send_to_auditor` | **block** | Listed so agents see the refusal. A person reviews and shares the folder. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

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
- A verified chain shows lines were not edited one by one. It cannot prove the log is complete or that the whole file was not rewritten.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/eirene-of-controls>
