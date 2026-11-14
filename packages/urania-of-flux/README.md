# Urania of Flux (`urania-of-flux`)

> Board pack assembly from locked source figures and documents, with variance commentary that cites its figures and a claims check on every number. Controller sign-off and distribution are each one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Urania a figures CSV (`id, metric, period, actual, budget, prior, source`) and the documents that go in the pack (Markdown or text). It:
- **locks** the figures file by hash. A pack is only built from locked figures, and sign-off is refused if they change afterwards;
- computes the variance of each figure against budget (or prior period when there is no budget) and flags material ones (`materiality_abs`, default 50,000, or `materiality_pct`, default 10%);
- drafts commentary, one line per material variance, citing the figure id (for example `[F1]`). Each "Reason" is left as `[TO WRITE]` for the line owner, because Urania does not guess causes;
- **checks claims**: every sentence with a number must cite a known figure id, and each number must match a value of a cited figure (actual, budget, prior, variance or variance %) at the precision written, so `$1.23M` matches 1,234,000 but `1.3M` does not. It reports uncited numbers, unknown citations and mismatches;
- assembles `board-pack.md` (variance table, commentary, each document with its hash, figure sources, claims-check result), `citations.csv` and `pack-manifest.json`.

Sign-off names the pack by its hash. It is refused while claims issues or `[TO WRITE]` markers remain, unless the controller accepts them with a note. Distribution is refused unless the sign-off matches the current pack exactly.

## Install

```bash
npm install -g urania-of-flux
urania-of-flux demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add urania-of-flux -- npx -y urania-of-flux@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "urania-of-flux": { "command": "npx", "args": ["-y", "urania-of-flux@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `urania_lock_figures` | **ask (Auto-eligible)** | Record the figures file hash in `figures.lock.json` |
| `urania_variance` | **allow** | Variances and materiality, plus the lock state |
| `urania_draft_commentary` | **ask (Auto-eligible)** | Write `commentary.md` with cited lines and owner `[TO WRITE]` reasons |
| `urania_check_claims` | **allow** | Check every number in the documents against its cited figure |
| `urania_assemble_pack` | **allow** | Write `board-pack.md`, `citations.csv`, `pack-manifest.json` (needs locked, unchanged figures) |
| `urania_record_signoff` | **ask · one-click** | After the controller's named click, write `signoff.json` for that pack hash |
| `urania_request_distribution` | **ask · one-click** | After a named click, record distribution of the signed pack |
| `board_portal_upload` | **block** | Listed so agents see the refusal. Urania never uploads. |
| `send_email` | **block** | Listed so agents see the refusal. Urania never sends. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `urania-of-flux approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`urania-of-flux kill`).

`urania_lock_figures` and `urania_draft_commentary` can go on Auto. A controller sign-off is an attestation and distribution is a send, so Urania files both under `binding_send`: they stay **one-click even in Auto**, and `--auto` on them is refused. Uploading and emailing stay **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
urania-of-flux tools
urania-of-flux call urania_check_claims '{"figures":"figures.csv","docs":["docs/ceo-letter.md","docs/ops-update.md"]}'
urania-of-flux eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not a close or consolidation tool. It does not produce your figures; it checks that the pack matches the figures you lock.
- The claims check is numeric. It cannot tell whether a sentence without numbers is true, and it checks values, not whether a figure id fits the sentence's meaning.
- Not accounting or audit advice, and it never distributes anything.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/urania-of-flux>
