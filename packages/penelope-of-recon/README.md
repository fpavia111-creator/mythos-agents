# Penelope of Recon (`penelope-of-recon`)

> Bank-to-GL reconciliation from CSV exports: proposed matches, reconciling items, a tie-out and draft adjusting entries. Posting is one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Penelope a bank statement export (`date, description, reference, amount`, or debit/credit columns) and the GL detail for the cash account. It proposes matches in this order:
- same reference and amount (high confidence);
- same amount within `date_window` days (default 3), nearest date first; ambiguous cases are marked low confidence;
- one bank line equal to 2–`max_group` GL lines (batched deposits).

What is left is listed by side: bank fees and interest (with a draft adjusting entry), returned items, and anything else in the bank only; deposits in transit and outstanding payments in the GL only. With both ending balances it ties adjusted bank to adjusted book and shows the difference. The workpaper has blank reviewer columns; proposed entries are marked "not posted".

## Install

```bash
npm install -g penelope-of-recon
penelope-of-recon demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add penelope-of-recon -- npx -y penelope-of-recon@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "penelope-of-recon": { "command": "npx", "args": ["-y", "penelope-of-recon@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `penelope_reconcile` | **allow** | Propose matches, list reconciling items, tie balances |
| `penelope_write_workpaper` | **allow** | Write `reconciliation.csv`, `reconciliation.md`, `proposed-entries.csv` to `mythos-out/penelope` |
| `penelope_accept_match` | **ask (Auto-eligible)** | Record an accepted match in `accepted-matches.csv` |
| `penelope_request_adjusting_entry` | **ask · one-click** | After a named human approves, record an entry for a person to post |
| `ledger_post_journal` | **block** | Listed so agents see the refusal. Penelope never writes to a ledger. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `penelope-of-recon approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`penelope-of-recon kill`).

`penelope_accept_match` can go on Auto (`--mode auto --auto penelope_accept_match`). Adjusting entries change the books, so Penelope files them under `move_money`: they stay **one-click even in Auto**. Posting to a ledger stays **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
penelope-of-recon tools
penelope-of-recon call penelope_reconcile '{"bank":"bank.csv","gl":"gl-cash.csv","bank_balance":12422.88,"gl_balance":12844.76}'
penelope-of-recon eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not an accounting system or close tool. It reads exports and writes files; it never posts to a ledger, bank or ERP.
- Matching is rule-based. Low-confidence and group matches need a person's check, and a tie-out is only as good as the exports and balances you give it.
- Not accounting or audit advice.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/penelope-of-recon>
