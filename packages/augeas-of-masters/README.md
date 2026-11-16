# Augeas of Masters (`augeas-of-masters`)

> Find duplicate vendors and items in master-data exports, and apply one approved merge at a time to a copy. Never edits your ERP.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Augeas reads a vendor or item export (CSV/JSON) and clusters likely duplicates using:
- names normalized (case, accents, punctuation and suffixes like Inc, LLC, Ltd, GmbH removed), compared word by word with Jaro-Winkler, with each word weighted by how rare it is in your file, so a shared common word such as "Supply" or "Logistics" does not make two vendors look alike while a typo in the distinctive word still matches;
- tax id (vendors) or UPC / part number (items), normalized (`12-3456789` = `123456789`);
- supporting signals: normalized postal address (Street → St…, same house number), phone (last 10 digits), business email domain.

Every linked pair carries its signals (`name`, `tax`, `address`, `phone`, `email_domain`), so a reviewer can see why. Two records with **different tax ids** are never put in one cluster, not even through a third record that has no tax id (those links are listed in `kept_apart`). A similar name with a different address *and* a different phone is not merged on its own. Each cluster gets a suggested survivor (active and most complete, or your own order), reasons and a confidence score.

Files over 400 rows use blocking (only records that share a name-word prefix, tax id, phone, house number + street or email domain are compared). On the seeded 1,000-row test file (fictional, generated in the test with a fixed seed, with typos, swapped words, suffix changes, missing tax ids and 40 near-name decoys), Augeas reaches precision 0.986 and recall 1.0 at the default threshold, and blocking finds the same clusters as comparing every pair. That is a synthetic benchmark; your data will differ.

Before a merge, **`augeas_merge_preview`** shows every column: each record's value, the winner, which record it came from, the survivorship rule and any conflict. Merges are applied **one at a time to a copy** (`<name>.merged.csv`, with a `merged_into` column; with `fill_survivor: true` the previewed winners are written into the survivor row). Every merge appends to `<name>.merged.csv.undo.jsonl`, and **`augeas_undo_merge`** restores the copy byte-for-byte to its state before the last merge (it checks hashes and refuses if the copy was edited since). The input file is never modified. Bank and payment columns are never changed by a merge.

CSV files are written so that a spreadsheet does not run cell text as a formula: a cell that starts with `=`, or with `+`, `-` or `@` in a way a spreadsheet would run as a formula, gets a leading apostrophe. Plain numbers, phone-style values and `@handles` are left as they are. If you import the file somewhere else, such a cell arrives with the apostrophe.

### Survivorship rules file

Optional `augeas-rules` JSON (unknown keys, wrong types and unknown rule names are refused with a JSON-pointer error; check one with `augeas-of-masters validate-config augeas-rules <file>`):

```json
{
  "default_rule": "survivor_fill_blank",
  "fields": { "address": "longest", "phone": "most_common", "email": "most_recent" },
  "date_column": "last_modified",
  "survivor": { "prefer_active": true, "order": "most_complete" },
  "protected_fields": ["isinactive"]
}
```

Rules: `survivor_fill_blank` (keep the survivor's value, fill it if blank), `survivor`, `most_complete`/`longest`, `most_common`, `most_recent` (needs `date_column`), `never`.

### Masters from other markets

Names in Japanese, Chinese and Korean are compared as written, and legal forms are ignored when comparing: `株式会社架空商事` and `架空商事(株)` read as one name, as do `(주)가상상사` and `가상상사 주식회사`, and `Beispiel AG` and `Beispiel`. The half-width bank form `ｶ)ｶｸｳｼｮｳｼﾞ` becomes `カクウショウジ`, which matches other katakana spellings of the name but not the kanji one. Id, name, tax id, phone, address and status columns are found by their names in eight languages (`仕入先コード`, `法人番号`, `사업자등록번호`, `Partita IVA`...). Two records with different tax ids are never put in one proposal.

Spanish, Mexican, Brazilian and Italian forms at the end of a name are ignored too (`Ejemplo S.L.`, `Ejemplo, S.A. de C.V.`, `Exemplo Ltda.`, `Exemplo ME`, `Esempio S.r.l.`). Tax ids that many unrelated parties share on purpose never link two records: Mexico's generic RFCs `XAXX010101000` and `XEXX010101000`, and all-same-digit values such as `000000000`. The result counts them under `not_compared`.

## Install

```bash
npm install -g augeas-of-masters
augeas-of-masters demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add augeas-of-masters -- npx -y augeas-of-masters@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "augeas-of-masters": { "command": "npx", "args": ["-y", "augeas-of-masters@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `augeas_find_duplicates` | **allow** | Cluster duplicates with reasons |
| `augeas_propose_merges` | **allow** | Write `merge-proposals.csv/json/html` to `mythos-out/augeas` |
| `augeas_merge_preview` | **allow** | Field-level winners, rules and conflicts for one merge; writes nothing |
| `augeas_apply_merge` | **ask (Auto-eligible)** | Apply one merge to the copy and append to the undo log |
| `augeas_undo_merge` | **ask (Auto-eligible)** | Reverse the last merge on the copy, byte-for-byte |
| `augeas_pay_vendor` | **block** | Listed so agents see the refusal. Augeas never moves money. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## MCP prompt

`augeas_dedupe_master` (arguments: `path`, `kind`, optional `rules`) walks a host model through find → proposals → preview → apply → undo, with a human yes on each merge.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `augeas-of-masters approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`augeas-of-masters kill`).

`augeas_apply_merge` is the one action you can put on Auto: `--mode auto --auto augeas_apply_merge --max-steps 25`. Each merge is still logged, the cap stops a runaway, and `kill` stops everything. Moving money stays **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
augeas-of-masters tools
augeas-of-masters call augeas_find_duplicates '{"path":"vendors.csv","kind":"vendor"}'
augeas-of-masters eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not an MDM platform, and it does not write to NetSuite or any ERP. You load the reviewed result yourself.
- The default threshold changed in 0.2.0 (now 0.92 on the new name score; the old 0.88 was on a different scale).
- Matching is heuristic. Check open transactions, balances, bank details and 1099/tax status before merging in the ERP.
- It does not touch bank details or payments.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/augeas-of-masters>
