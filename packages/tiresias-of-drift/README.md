# Tiresias of Drift (`tiresias-of-drift`)

> Compare config and schema snapshots over time and explain each drift with a risk level. Applying a fix to production is one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Tiresias reads snapshots you already export: JSON config, `.env` / `.properties` files (`KEY=value`), and schema CSVs (`table, column, type, nullable, default`). It:
- lists every added, removed and changed key, highest risk first, with a plain reason (TLS or verification switched off, CORS or a CIDR opened to everyone, debug turned on, a secret changed, a column dropped, a type narrowed, nullability tightened…);
- **never shows secret values** (keys like password, token, api_key, secret are masked);
- walks a folder of dated snapshots and says when each key first drifted, plus net drift from first to latest;
- skips noisy keys you list in `ignore` (for example `meta.generated_at` or `build.*`);
- drafts a revert plan back to the earlier snapshot, as a proposal.

## Install

```bash
npm install -g tiresias-of-drift
tiresias-of-drift demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add tiresias-of-drift -- npx -y tiresias-of-drift@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "tiresias-of-drift": { "command": "npx", "args": ["-y", "tiresias-of-drift@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `tiresias_diff` | **allow** | Compare two snapshots |
| `tiresias_timeline` | **allow** | Drift across a folder of dated snapshots |
| `tiresias_write_report` | **allow** | Write `drift-report.md`, `drift.json`, `revert-plan.json` to `mythos-out/tiresias` |
| `tiresias_apply_fix` | **ask · one-click** | After a named human approves, record the fix in `apply-request-*.json` for your change process |
| `production_push_config` | **block** | Listed so agents see the refusal. Tiresias never writes to a live system. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `tiresias-of-drift approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`tiresias-of-drift kill`).

All analysis tools are read or report. Applying a fix is `production_deploy`: it stays **one-click even in Auto**, and `--auto tiresias_apply_fix` is refused. Pushing config stays **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
tiresias-of-drift tools
tiresias-of-drift call tiresias_timeline '{"dir":"snapshots","ignore":["meta.generated_at"]}'
tiresias-of-drift eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not a configuration management, IaC or monitoring tool. It compares files you give it and changes nothing.
- Risk levels come from key names and values, not from knowledge of your system. A low-risk label is not a promise the change is safe.
- It does not fetch snapshots; export them on your own schedule.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/tiresias-of-drift>
