# Helios of Seats (`helios-of-seats`)

> Find unused, idle, duplicate and over-tiered SaaS seats (AI tools included) and estimate the saving. Revoking is one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Helios a seat export (`app, user, email, tier, monthly_cost, last_active, premium_features_used, status`; column names matched loosely) and, optionally, an HR roster (`email, status`). It flags:
- seats never used, or idle longer than `idle_days` (default 60);
- duplicate seats for the same person in the same app;
- leavers (terminated in HR) and people missing from the roster;
- premium tiers (Pro, Business, Enterprise, Team…) where premium features are marked unused.

Each seat gets a suggested action and an estimated monthly saving (a downgrade saves `downgrade_ratio` of the cost, default 0.5); seats with no cost are counted separately, never guessed. It writes a review sheet with blank reviewer columns.

## Install

```bash
npm install -g helios-of-seats
helios-of-seats demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add helios-of-seats -- npx -y helios-of-seats@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "helios-of-seats": { "command": "npx", "args": ["-y", "helios-of-seats@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `helios_find_waste` | **allow** | Flag waste, per seat and per app, with estimated savings |
| `helios_write_review` | **allow** | Write `seat-review.csv` + summary to `mythos-out/helios` |
| `helios_request_downgrade` | **ask (Auto-eligible)** | Record a downgrade request for the app admin |
| `helios_request_revoke` | **ask · one-click** | After a named human approves, record a revocation request for the app admin |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `helios-of-seats approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`helios-of-seats kill`).

`helios_request_downgrade` can go on Auto (`--mode auto --auto helios_request_downgrade`). Revoking a seat is `revoke_access`: it stays **one-click even in Auto**, and `--auto helios_request_revoke` is refused.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
helios-of-seats tools
helios-of-seats call helios_find_waste '{"seats":"seats.csv","roster":"hr-roster.csv","idle_days":60}'
helios-of-seats eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not a SaaS management platform. It connects to no app and changes no seat; an admin does that.
- Savings are estimates from your cost column. Annual prepay, contract minimums and renewal dates can mean a removed seat saves nothing until renewal.
- `last_active` is only as good as the export it came from.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/helios-of-seats>
