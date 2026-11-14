# Agon of Evals (`agon-of-evals`)

> Private, fixture-based evals for one business process on one pinned model. Grades recorded responses; calls no model; publishes nothing.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

You write a suite (`suite.json`: the process, the pinned model id, and cases with checks) and record your agent's responses (JSONL: `case_id, output, tool_calls, model`). Agon grades them deterministically. Checks:
- `contains`, `not_contains`, `regex`, `not_regex`, `equals`;
- `max_words`, `min_words`;
- `refusal` / `no_refusal`;
- `required_tools`, `forbidden_tools` (for example "never call `update_vendor_bank`");
- `number` with a tolerance (`$1,250.00` reads as 1250).

The suite must pin an exact model id (no `latest`). Responses with no model id, or from a different model, are graded but marked **not comparable**. `agon_compare` lists regressions and fixes between a baseline and a candidate run. Reports come as Markdown, JSON and JUnit XML for CI.

## Install

```bash
npm install -g agon-of-evals
agon-of-evals demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add agon-of-evals -- npx -y agon-of-evals@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "agon-of-evals": { "command": "npx", "args": ["-y", "agon-of-evals@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `agon_validate_suite` | **allow** | Check the suite: pinned model, ids, checks, regexes |
| `agon_grade` | **allow** | Grade one recorded run |
| `agon_compare` | **allow** | Baseline vs candidate: regressions, fixes, delta |
| `agon_write_report` | **allow** | Write `eval-report.md`, `eval-results.json`, `junit.xml` to `mythos-out/agon` |
| `agon_publish_results` | **block** | Listed so agents see the refusal. Results stay private. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `agon-of-evals approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`agon-of-evals kill`).

All tools are read or report, so Auto changes nothing here. Publishing scores is `binding_send` and stays **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
agon-of-evals tools
agon-of-evals call agon_compare '{"suite":"suite.json","baseline":"baseline.jsonl","candidate":"candidate.jsonl"}'
agon-of-evals eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not a benchmark or leaderboard, and a score is not a certification. It covers your suite and your pinned model only.
- It does not run your agent or call any model. You record the responses; Agon grades them.
- Rule-based checks cannot judge open-ended quality. Use them for things that must or must not happen.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/agon-of-evals>
