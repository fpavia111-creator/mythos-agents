# Urania of Flux (`urania-of-flux`)

> Board pack assembly from locked source figures and documents, with variance commentary that cites its figures and a claims check on every number. Controller sign-off and distribution are each one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Urania a figures CSV (`id, metric, period, actual, budget, prior, source`) and the documents that go in the pack (Markdown or text). It:
- **locks** the figures file by hash. A pack is only built from locked figures, and sign-off is refused if they change afterwards;
- computes the variance of each figure against budget (or prior period when there is no budget) and flags material ones (`materiality_abs`, default 50,000, or `materiality_pct`, default 10%);
- drafts commentary, one line per material variance, citing the figure id (for example `[F1]`). Each "Reason" is left as `[TO WRITE]` for the line owner, because Urania does not guess causes;
- **checks claims**: every sentence with a number must cite a known figure id, and each number must match a value of a cited figure (actual, budget, prior, variance or variance %) at the precision written, so `$1.23M` matches 1,234,000 but `1.3M` does not, and `up 12%` matches a 12.18% variance but `up 12.3%` does not. A hedge ("about", "roughly", "nearly", "~") widens the match to one full unit of the last digit. A percentage can also be a ratio or change between two cited figures (`58.5% of revenue [F3, F1]`). When a sentence uses only "up" words (up, above, over, rose…) or only "down" words (down, below, under, fell…), a number that matched a variance must have that sign, so "5,000 above budget" on a figure that is 5,000 *under* budget is flagged. It reports uncited numbers, unknown citations, mismatches and wrong directions;
- **compares with the prior pack**: given last month's figures file, it flags prior-period values that no longer equal what was reported (restatements), same-period values that changed, new and dropped metrics and changed figure ids, and lists every sentence that cites an affected figure so its author can re-read it. With the prior `pack-manifest.json` it also checks the prior figures file is the one that pack was built from;
- **draws charts** from the locked figures only: self-contained SVG (no scripts, no links, no external references) for variance, variance % and actual against budget. Every bar carries `data-figure-id`, `data-field` and `data-value`, and `charts.json` lists each point, so every mark traces to a figure id;
- assembles `board-pack.md` (variance table, commentary, each document with its hash, figure sources, claims-check result), `citations.csv` and `pack-manifest.json`, and on request a self-contained `board-pack.html` (no scripts; the charts inline). The pack hash is recorded as `output_sha256` in the audit line.

Sign-off names the pack by its hash. It is refused while claims issues or `[TO WRITE]` markers remain, unless the controller accepts them with a note, and refused if `board-pack.md` or `board-pack.html` changed after assembly. Distribution is refused unless the sign-off matches the current pack exactly. `pack-manifest.json` is validated against a JSON Schema whenever Urania reads it back (`urania-of-flux validate-config pack_manifest <file>`).

## Install

```bash
npm install -g urania-of-flux
urania-of-flux demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add urania-of-flux -- npx -y urania-of-flux@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "urania-of-flux": { "command": "npx", "args": ["-y", "urania-of-flux@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `urania_lock_figures` | **ask (Auto-eligible)** | Record the figures file hash in `figures.lock.json` |
| `urania_variance` | **allow** | Variances and materiality, plus the lock state |
| `urania_draft_commentary` | **ask (Auto-eligible)** | Write `commentary.md` with cited lines and owner `[TO WRITE]` reasons |
| `urania_check_claims` | **allow** | Check every number in the documents against its cited figure |
| `urania_compare_prior` | **allow** | Restatements, new/dropped metrics and changed ids against the prior pack's figures, with the sentences they touch |
| `urania_charts` | **allow** | Write SVG charts and `charts.json` from locked, unchanged figures; every point traces to a figure id |
| `urania_assemble_pack` | **allow** | Write `board-pack.md`, `citations.csv`, `pack-manifest.json`, and `board-pack.html` with `html: true` (needs locked, unchanged figures) |
| `urania_record_signoff` | **ask · one-click** | After the controller's named click, write `signoff.json` for that pack hash |
| `urania_request_distribution` | **ask · one-click** | After a named click, record distribution of the signed pack |
| `board_portal_upload` | **block** | Listed so agents see the refusal. Urania never uploads. |
| `send_email` | **block** | Listed so agents see the refusal. Urania never sends. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

### MCP prompt

`urania_board_pack` (arguments `figures`, `docs`, `period`, optional `prior_figures`) walks a host model through the whole workflow in order: variances, prior-pack comparison, lock, commentary draft, claims check, charts, assembly, and where the controller's sign-off and distribution clicks come in.

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
- The claims check is numeric. It cannot tell whether a sentence without numbers is true, and it checks values, not whether a figure id fits the sentence's meaning. The direction check is a word list (English only); it skips sentences that mix "up" and "down" words, and numbers that also match a level (actual, budget or prior).
- Prior-pack comparison matches figures by metric name, then by id. A renamed metric shows up as one dropped and one new metric.
- Charts are plain horizontal bars. They do not replace your board-deck design; amounts on one chart share one scale, so very large lines (such as cash) can dwarf small ones — use `ids` to chart a subset.
- Not accounting or audit advice, and it never distributes anything.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/urania-of-flux>
