# Ladon of Access (`ladon-of-access`)

> Access recertification for people, AI agents and service accounts. A named human decides. Never revokes by itself.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Ladon an access export (one row per account per system: `system, user, email, account_type, role, owner, last_login, status, mfa`) and, optionally, an HR roster (`email, status, termination_date`). Column names are matched loosely. It flags:
- people marked terminated in HR, or missing from the roster;
- stale (default 90 days) and never-used logins;
- privileged roles (Administrator, Full Access, Super Admin, Payments Admin… or your own list), and privileged accounts without MFA;
- **agents and service accounts with no owner**;
- shared/generic and duplicate accounts.

Then it writes a recertification sheet with blank `reviewer_decision`, `reviewer_name` and `review_date` columns for the owner to fill in.

## Install

```bash
npm install -g ladon-of-access
ladon-of-access demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add ladon-of-access -- npx -y ladon-of-access@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "ladon-of-access": { "command": "npx", "args": ["-y", "ladon-of-access@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `ladon_review_access` | **allow** | Flag risky accounts, highest risk first |
| `ladon_recert_sheet` | **allow** | Write `recertification.csv` + summary to `mythos-out/ladon` |
| `ladon_request_revocation` | **ask · one-click** | After a named human approves, append a request to `revocation-requests.csv` for the system admin |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `ladon-of-access approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`ladon-of-access kill`).

Revoking access is `revoke_access`: it stays **one-click even in Auto**, and `--auto ladon_request_revocation` is refused. Auto still runs the reviews and sheets without stopping.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
ladon-of-access tools
ladon-of-access call ladon_review_access '{"access":"access-export.csv","roster":"hr-roster.csv","stale_days":90}'
ladon-of-access eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not an identity provider or IGA platform. It does not connect to any system and does not remove access; an admin does that.
- `suggested_action` is a hint. The reviewer's decision is the decision.
- The sheet supports a review. On its own it is not evidence that a review happened.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/ladon-of-access>
