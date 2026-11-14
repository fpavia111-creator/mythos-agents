# Epimetheus of Scripts (`epimetheus-of-scripts`)

> Inventory SuiteScript files and risk-rank what must move to SuiteScript 2.1. Never deploys code.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Point Epimetheus at a folder of scripts (an SDF project, a FileCabinet download, or any folder of `.js` files). It reads each file and reports:
- the SuiteScript version: `1.0` (nlapi/nlobj calls, no `@NApiVersion`), `2.0`, `2.x` or `2.1`, and `unknown` when it cannot tell;
- the script type (`@NScriptType`);
- every 1.0 API call with its line number and a SuiteScript 2.1 module hint (for example `nlapiRequestURL` → `N/https request()`);
- a risk score (0–100) with plain reasons: version, record writes, outbound HTTP/email, scheduling/yield logic, size.

Oracle has announced that custom scripts must run on SuiteScript 2.1 by NetSuite 2028.2. Check the dates and scope against the notice in your own account.

## Install

```bash
npm install -g epimetheus-of-scripts
epimetheus-of-scripts demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add epimetheus-of-scripts -- npx -y epimetheus-of-scripts@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "epimetheus-of-scripts": { "command": "npx", "args": ["-y", "epimetheus-of-scripts@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `epimetheus_inventory` | **allow** | Scan a folder, rank by risk |
| `epimetheus_explain_file` | **allow** | Line-by-line 1.0 calls with 2.1 hints |
| `epimetheus_write_plan` | **allow** | Write `inventory.csv` + `conversion-test-plan.md` to `mythos-out/epimetheus` |
| `epimetheus_deploy_conversion` | **block** | Listed so agents see the refusal. Deploys go through your own release process. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `epimetheus-of-scripts approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`epimetheus-of-scripts kill`).

All tools are read or report. Deploying is `production_deploy`, which is one-click by rule and **blocked** in this pack.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
epimetheus-of-scripts tools
epimetheus-of-scripts call epimetheus_inventory '{"dir":"src/FileCabinet"}'
epimetheus-of-scripts eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not a converter. It does not rewrite or deploy code, and it does not claim a better conversion than Oracle's own tooling.
- Detection is pattern-based. Dynamic or minified code can hide calls; `unknown` files need a manual look.
- API hints are a starting point. Behaviour differences between 1.0 and 2.1 must be tested.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/epimetheus-of-scripts>
