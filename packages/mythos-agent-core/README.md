# mythos-agent-core

The shared core for **Mythos Machine domain agents**: small MCP agents that each own one business process and cannot act outside it.

- **Pack manifest** — name, version, a declared model pin, the tool allowlist and the policy. `defineManifest()` fails closed: an unpinned model (`latest`), a tool without a rule, a write marked `allow`, or a one-click action marked `allow` are rejected at load time.
- **Talos-style policy** — every tool call gets `allow`, `ask` or `block`. Unknown tools are blocked. The default is block.
- **Modes**
  - **Review**: read and report tools only. Everything else is blocked.
  - **Assist** (default): the policy as written. `ask` returns an `approval_id` and waits for a named human.
  - **Auto**: off by default and **opt-in per action** (`--auto tool_a,tool_b`). Only opted-in `ask` actions run without a click. Step and spend caps and a kill switch always apply.
- **Always one-click, even in Auto**: `go_live`, `revoke_access`, `delete_personal_data`, `move_money`, `binding_send`, `production_deploy`, and `accept_learning` (changing what an agent remembers). Trying to put one of these on Auto throws an error. Auto prepares the work; a person clicks.
- **Audit log** — append-only JSONL (`.mythos/audit.jsonl`), one line per decision, hash-chained so edits and removed lines show up. Arguments are stored as a SHA-256 hash, not in full. Field names follow Alethea's record vocabulary (`id`, `type`, `date`, `requirements`) so logs sit cleanly next to an Alethea `.decisions/` folder; this package does not write into `.decisions/`.
- **Stdio MCP server** — zero-dependency, newline-delimited JSON-RPC 2.0 (`initialize`, `ping`, `tools/list`, `tools/call`, `prompts/list`, `prompts/get`), protocol versions up to `2025-11-25`, tool annotations (`readOnlyHint`, `destructiveHint`, …) derived from each tool's kind, plus a built-in `mythos_info` tool that reports usage and pending approvals.
- **Input validation** — every call is checked against the tool's `inputSchema` before anything runs or reaches a human. Errors carry JSON-pointer paths (`/vendors/3/tin expected string`).
- **Signed audit log (opt-in)** — with `--signing-key`, every line is also signed with Ed25519. A re-chained file fails `verify-log --pubkey`. Key rotation is recorded as a signed entry.
- **Approvals people can actually use** — CLI, a local approvals page on 127.0.0.1, or an HMAC-signed webhook callback. Approvals are single-use, bound to the exact arguments, expire after 24 h by default, and can be rejected.
- **Caps that survive restarts** — per session, per day and per tool, persisted in `.mythos/usage.json`.
- **Domain memory (opt-in per agent)** — an agent can remember facts about one customer's setup in its own specialty (a column name, an extra privileged role). Learning only proposes; a fact applies after a named person accepts it, every result says which facts it used, and the file is hash-chained like the audit log. See [Domain memory](#domain-memory).
- **Private evals** — fixture-based, deterministic test cases, with an offline HTML report and regression highlighting against a baseline.
- **Shared helpers** — JSON Schema validation, iCalendar, SARIF 2.1.0, unified diff/patch, Jaro-Winkler and name/address normalisation, entropy, a small ZIP/DOCX reader, and a self-contained HTML page template.

MIT, Node ≥ 20, no runtime dependencies.

## Install

```bash
npm install mythos-agent-core
```

## A pack in 30 lines

```js
import { defineManifest, main } from 'mythos-agent-core';

const manifest = defineManifest({
  name: 'my-pack', version: '0.1.0', description: 'One process, nothing else.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929' },
  tools: [
    { name: 'my_check', kind: 'read', description: 'Read a CSV and report.',
      inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
      handler: async (args, ctx) => { const rows = ctx.records(args.path); return { summary: `${rows.length} rows`, rows: rows.length }; } },
    { name: 'my_fix', kind: 'write', description: 'Change something (needs a human).', handler: async () => ({ summary: 'done' }) },
    { name: 'my_go_live', kind: 'action', category: 'go_live', description: 'Never by an agent.' },
  ],
  policy: { rules: [
    { tool: 'my_check', decision: 'allow' },
    { tool: 'my_fix', decision: 'ask', reason: 'writes need a human' },
    { tool: 'my_go_live', decision: 'block' },
    { tool: '*', decision: 'block' },
  ] },
});

main(manifest); // gives you: mcp | tools | call | demo | eval | approve | reject | approvals | usage | keygen | verify-log | kill | unkill
```

`ctx.records(path)` reads CSV, JSON or JSONL; `ctx.path()` refuses paths outside `--root`; `ctx.outDir()` creates an output folder inside it.

## Scaffold a new agent

```bash
npx -y -p mythos-agent-core mythos-new-agent iris-of-tests --dir packages
```

The generated package passes `npm test`, `eval` and `npm pack --dry-run` as is. See `docs/build-an-agent.md` in the monorepo.

## Approvals

When a call is `ask`, the result contains an `approval_id` bound to that exact tool and arguments. A person approves it once:

```bash
npx -y -p mythos-agent-core mythos-approve 3f2a9c1d0b7e6a55 --as "Your Name" --dir .mythos
```

Then the same call runs and the log records who approved it.

Other ways to decide:

- `npx <pack> approvals serve` opens a local page (127.0.0.1 only, strict CSP, no scripts, a per-start form token, Host and Origin checks) that lists pending approvals with a short, non-sensitive preview of the arguments. Type your name and approve once, or reject.
- `--approval-webhook https://…` POSTs each new pending approval to your endpoint, signed with `MYTHOS_WEBHOOK_SECRET` (HMAC-SHA256, header `x-mythos-signature: t=<unix>,v1=<hex>`). Your system answers by POSTing `{ "id", "decision": "approve"|"reject", "by": "Person Name" }`, signed the same way, to the approvals page's `/callback`. A bad signature, a timestamp older than 5 minutes or a missing name is refused and audited.
- `npx <pack> reject <id> --as "Name"` refuses a pending action.

Approvals expire 24 hours after a person approves (`--approval-ttl HOURS`). Names like "agent" or "claude" are refused as approvers. One-click categories can be approved by a person through any of these routes, but never by Auto.

**Honest limit:** approvals are a file. If the agent also has a shell in the same folder, it could write that file itself. For approvals to mean something, give the agent the MCP server only, not a shell, or keep `--state-dir` somewhere the agent cannot write.

## Domain memory

An agent can remember facts about one customer's setup in its own specialty, so the next run does not have to be told again: "their key column is `legacy_id`", "Vault Keeper is a privileged role here". The agent declares which kinds of fact it can learn and what each one changes. Nothing else can be learned.

```js
import { defineManifest, memoryTools } from 'mythos-agent-core';

const KINDS = {
  privileged_role: {
    description: 'A role this customer treats as privileged, e.g. {"role": "Vault Keeper"}.',
    effect: 'adds the role to the privileged list (more findings, never fewer)',
    schema: { type: 'object', additionalProperties: false, required: ['role'], properties: { role: { type: 'string', minLength: 2, maxLength: 100 } } },
    check: (v) => null, // optional: return a reason to refuse a value
  },
};
const mem = memoryTools('acme', KINDS);   // acme_recall, acme_learn, acme_accept_learning, acme_retire_memory

export const manifest = defineManifest({
  name: 'acme-of-access', /* … */
  memory: { prefix: 'acme', kinds: KINDS },
  tools: [
    { name: 'acme_review', kind: 'read', description: '…', handler: async (a, ctx) => {
      const extra = ctx.memoryFacts('privileged_role').map((f) => f.value.role); // accepted facts only
      /* … use them to add checks … */
    } },
    ...mem.tools,
  ],
  policy: { rules: [{ tool: 'acme_review', decision: 'allow' }, ...mem.rules, { tool: '*', decision: 'block' }] },
});
```

| Tool | Kind | Policy | What it does |
|---|---|---|---|
| `<prefix>_recall` | read | allow | Search what the agent has learned: accepted facts, facts waiting for a person, and their history. Says whether the file verifies. |
| `<prefix>_learn` | report | allow | Propose one fact. It is stored as waiting and changes nothing. Records the hash of any `source_files` it came from. |
| `<prefix>_accept_learning` | action | ask · one-click (`accept_learning`) | A named person accepts or rejects a waiting fact. Never on Auto. |
| `<prefix>_retire_memory` | action | ask · one-click (`accept_learning`) | A named person stops an accepted fact. The history stays. |

What is enforced in code, not left to the model:

- **One file per agent**: `.mythos/memory/<agent>.jsonl`. The runtime picks it from the manifest name; no tool argument names a file or another agent. Lines written for another agent are ignored and reported.
- **Only declared kinds**, each checked against its JSON Schema (which must set `additionalProperties: false`) and its optional `check`. A built-in `note` kind is for people and changes no check. Policy, caps, Auto opt-ins and one-click categories are not memory and cannot be learned.
- **Learning only proposes.** A fact applies from the next call after a named person accepts it. Accepting is the one-click category `accept_learning`, so it always asks, even in Auto.
- **Each acceptance is checked against the approvals file**: the approval must be by the same person, given before the line was written, for exactly that fact and decision (the approval id is a hash of the tool and its arguments). A properly chained "accepted" line with no such approval is shown as `unverified` and not used. The same check applies to retiring a fact.
- **Tamper-evident**: the file is hash-chained like the audit log, and signed with the same key when `--signing-key` is set. A fact's id is a hash of its content, so a value edited in place (even in a re-chained file) no longer matches its id or its approval and is ignored. If it does not verify, no accepted fact is used and every result says so. `<pack> memory verify` also cross-checks the audit log: an acceptance the audit log says ran but the memory file lacks (lines cut from the end) is reported.
- **Refused values**: private keys, AWS/Stripe/GitHub/Slack tokens, `password: …` patterns, long random-looking strings, US social security numbers, and text that reads like instructions to an AI. At most 200 facts can wait for a person and 5,000 facts are kept.
- **Every result says what it used**: `memory_applied` on the call result (id, kind, value, who accepted it) and the ids in the audit line. `--no-memory` (or `memory: false`) runs without learned facts; recall and learn still work.

From the command line:

```bash
npx <pack> memory list                                   # accepted and waiting facts
npx <pack> memory accept MEM-1a2b3c4d5e6f --as "Your Name" --reason "Checked with the controller"
npx <pack> memory reject MEM-1a2b3c4d5e6f --as "Your Name"
npx <pack> memory retire MEM-1a2b3c4d5e6f --as "Your Name" --reason "Role removed in March"
npx <pack> memory verify [--pubkey public.pem]
```

`memory accept` takes the same path as the agent: the call asks, the named person approves, the call runs. Whoever approves sees the fact itself (kind, value, note and what it changes), not just its id: in the `needs_approval` result (`approving`), on the approvals page and in `approvals list`. Any tool can offer this with an `approvalPreview(args, ctx)` function.

**Honest limits:** the same as approvals. If the agent also has a shell in the same folder, it could write the memory and approvals files. Without a signing key, someone with write access to both the memory file and the approvals file could forge a fact and its approval together; with `--signing-key` (key kept outside `--root`) a rewritten memory file fails `memory verify --pubkey`. Removing lines from the end of an unsigned file is only caught by the audit-log cross-check. Learned facts are what a person accepted, not proof that they are right.

## Kill switch and caps

- `npx <pack> kill` creates `.mythos/KILL`; every call is then blocked until `unkill`. `MYTHOS_KILL=1` does the same.
- `--max-steps N` and `--max-spend USD` stop a session and report. Spend counts each tool's declared `costUsd` (the wave-1 packs are local and declare $0), plus any `costUsd` a handler returns.

- Caps persist in `.mythos/usage.json`: `--session ID` keeps a session's count across restarts, `--max-steps-per-day` and `--max-spend-per-day` cap a whole day, and a manifest can set `caps.perTool.<tool>.maxSteps` so one tool cannot use the whole budget. A cap hit returns `{ status: "blocked", cap: { cap, scope, limit, used } }` and is audited. `npx <pack> usage` shows the counters.

## Verify a log

```bash
npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl
```

Unsigned, the chain is tamper-evident, not tamper-proof: someone with write access can rewrite the whole file. To close that gap, sign it:

```bash
npx <pack> keygen --out ~/.mythos-keys/my-pack        # keep this outside --root
npx <pack> mcp --signing-key ~/.mythos-keys/my-pack/private.pem --audit-mirror /backup/my-pack-audit.jsonl
npx <pack> verify-log --pubkey ~/.mythos-keys/my-pack/public.pem
npx <pack> rotate-key --signing-key OLD.pem --new-key NEW.pem --as "Your Name"
```

The key is refused if it sits under `--root`, and it is never logged. With `--pubkey`, every line must carry a valid signature from a trusted key (or a key introduced by a signed rotation). Old unsigned logs still verify as "chained, unsigned". Signing proves the lines came from whoever holds the key; it cannot stop that holder from writing a false line.

## Untrusted data and broken arguments

Agents read files that other people wrote: vendor names, memos, email bodies, page content. The runtime treats that text as hostile until shown otherwise, for every pack built on it.

- **Spreadsheets.** `toCsv` puts an apostrophe in front of a cell that a spreadsheet would run as a formula (it starts with `=`, or with `+`, `-` or `@` and is not a plain number, a phone-style value or a bare `@handle`). Pass `{ formulas: 'keep' }` for a file only a program reads.
- **Markdown.** `ctx.writeFile` passes `.md` output through `safeMarkdown`: raw HTML outside code becomes literal text (`\<script>`), and remote or reference-style images become plain text, so a Markdown preview shows what a data cell contained instead of rendering it or fetching an image for it. Links are left as they are. Pass `{ raw: true }` when the file is a copy of the person's own document. If you store a hash of Markdown you write, hash `safeMarkdown(text)` or the file itself.
- **File names.** `ctx.writeFile(dir, name, …)` refuses a name that leaves `dir`. Use `safeFileName(id)` when a name comes from data.
- **HTML.** `htmlPage` wraps every table so a wide one scrolls inside the page on a phone, adds `scope` to header cells for screen readers, and right-aligns the header of a numeric column. `bodyHtml` must still be escaped with `escapeHtml` by the pack.
- **Instructions aimed at the model.** When a result quotes text that reads like instructions to an AI ("ignore previous instructions", fake chat markup, "do not tell the user", hidden or direction-flipping characters), the result carries a `warnings` entry and the audit line an `injection_signals` list. The data is returned unchanged. This is a short, high-precision heuristic (`injectionSignals`): it catches common shapes and misses others. The MCP `initialize` instructions also tell the host model that tool results are data. One-click actions still need a named human whatever the model was told.
- **Arguments.** A misspelled argument that is one or two letters from a real one (`receipt` for `receipts`, `outdir` for `out_dir`) is refused with the right name. An unrelated extra argument is refused by tools that set `additionalProperties: false`, and otherwise ignored with a `warnings` entry and an `ignored_args` audit field. A required argument given as an empty string counts as missing.
- **Errors.** File errors are plain sentences with paths relative to `--root` ("file not found: data/vendors.csv"); the absolute root never appears in an error, and long messages are clipped at about 1,200 characters.

`node scripts/hostile-inputs.mjs` in the monorepo plants hostile values in every pack's fixtures, runs every eval case and inspects the output; `--args` also calls every tool with broken arguments.

## Configs

A pack can declare `configSchemas: { playbook: { …JSON Schema… } }`. Handlers load configs with `ctx.readJson(path, 'playbook')`, which fails with JSON-pointer errors, and people can check a file before use with `npx <pack> validate-config playbook ./my-playbook.json`.

## Prompts

A pack can ship MCP prompts (`prompts: [{ name, description, arguments, text }]`) that walk a host model through its workflow. `{{arg}}` placeholders are filled from the prompt arguments.

## Eval reports

```bash
npx <pack> eval --report eval-out/          # report.json + report.html (no scripts, no network)
npx <pack> eval --report eval-new/ --baseline eval-out/report.json   # exits 1 on a regression
```

## Reading real exports

`ctx.records(path)` reads CSV, TSV, semicolon- or pipe-separated text, Excel `.xlsx` (first visible sheet unless one is named; formulas are never evaluated), JSON (an array, or an object holding one array such as `records`, `data` or `items`) and JSONL. `.xls` is refused with advice to save as `.xlsx` or CSV.

A pack can declare the files it reads under `sources`: its own columns (`fields`, with a type and a list of other names each column goes by) and `profiles` for named exports from real systems, built from the shared catalogue in `src/exports.js`:

```js
import { exportProfile, fullName } from 'mythos-agent-core';
sources: {
  access: {
    label: 'Access export', args: ['access', 'previous'],
    fields: { user: { aliases: ['Display Name'], required: true }, email: { type: 'email' }, last_login: { type: 'date', aliases: ['Last Sign In'] } },
    profiles: [exportProfile('google_workspace_users', { user: fullName('First Name [Required]', 'Last Name [Required]'), email: 'Email Address [Required]', last_login: 'Last Sign In [READ ONLY]' })],
  },
}
```

What happens to a file:
- In the pack's own columns: returned untouched.
- Otherwise: the export is recognised by its column names (or by its first row, for a headerless bank download), a title block above the header row is skipped, columns are renamed in place, other columns pass through, dates become `YYYY-MM-DD` (month-first or day-first is inferred from the values; a guess is said aloud), amounts become plain decimals (`$1,200.00`, `(45.10)`, `1.234,56 €`), yes/no columns become `yes`/`no`, emails are lowercased.
- The tool result gets a `sources` list (export recognised, columns mapped and not used, rows skipped, the date order read, notes about what the export lacks) and its `warnings` carry anything a person should check. The audit line records a compact version with no cell values.
- A file with none of a required column is read as it is and the result says which column was not found.

`<pack> sources` lists what a pack reads. `<pack> inspect <file>` (and the MCP tool `mythos_inspect_input`) shows how one file would be read: format, sheets, header row, each column's name and shape (dates day-first, amounts, yes/no...), never a cell value. Column names that read like instructions to an AI are flagged.

When a file does not match, put `mythos-sources.json` in the root (checked against a schema on every call):

```json
{
  "sources": { "access": { "date_order": "dmy" } },
  "files": { "exports/okta.csv": { "profile": "okta_users_api", "columns": { "email": "Work E-mail" }, "set": { "system": "Okta" }, "skip_rows": 2, "sheet": "Users", "decimal": ",", "delimiter": ";" } }
}
```

How far to trust the layouts: two (Procore RFIs, Ramp transactions) were compared with the vendor's documentation on 2026-11-15. The others were written from knowledge of each export and not checked. None was tested against a live account. `<pack> sources` marks which is which.

## Files and reports from other markets

The core reads exports the way systems in Germany, France, Spain, Brazil, Italy, Japan, China, Korea and the English-speaking countries write them. These nine languages cover the largest business-software markets (sources in the ver 6 review).

- **Text encodings.** A file is decoded by the first of: the `encoding` set for it in `mythos-sources.json`; a byte-order mark (UTF-8, UTF-16); strict UTF-8; UTF-16 without a mark; a scored guess among Shift_JIS, EUC-KR, GB18030, Big5 and Windows-1252 (known header words count most, and `--lang` breaks ties). A guessed encoding is named in the result's warnings with how to fix it. Names you can set: `utf-8`, `utf-16le`, `utf-16be`, `shift_jis`, `euc-jp`, `euc-kr`, `gb18030`, `gbk`, `big5`, `windows-1252`, `iso-8859-1`, `iso-8859-15` and common aliases (`sjis`, `cp932`, `cp949`, `cp936`, `latin1`...).
- **Amounts.** `1.234,56`, `1 234,56`, `1'234.56`, `12,5`, `R$ 1.234,56`, `1,200円`, `￥1,200`, `₩15,000`, Japanese negatives `△300` and `▲300`, `(45.10)`, a trailing minus and Indian grouping `12,34,567`. A whole column decides whether the comma is the decimal mark, so `1.234` in a column that also holds `2.500,50` reads as 1234. `toNumber("12,5")` is 12.5 (before ver 6 it was 125).
- **Dates.** Month names in English, German, French, Spanish, Portuguese, Italian and Dutch, also between slashes (`14/NOV/2026`, as Mexican and Brazilian bank exports write them); `2026年11月14日`, `2026년 11월 14일`, `2026. 11. 14.`; Japanese era years (`令和8年11月14日`, `R8.11.14`) and Taiwan 民國 years; 午前/午後 and 오전/오후 times.
- **Column names.** About 100 common columns are known in German, French, Spanish, Portuguese, Italian, Japanese, Chinese and Korean (`Betrag`, `Montant`, `Importe`, `Valor`, `Importo`, `金額`, `金额`, `금액`...). They fill only columns still unmatched after the English names and never take a column already used; the result lists them under `translated_columns`. A field can opt out with `translate: false` or point at another concept, for example `translate: 'ledger_debit'` so a general-ledger debit reads `Soll` or `借方` rather than a bank's money-out column.
- **Yes and no.** Yes/no columns read `ja`, `oui`, `sí`, `sim`, `sì`, `はい`, `有効`, `是`, `예`, `○` and their opposites.
- **Names.** `normalizeName`, `normalizeAddress`, `safeFileName` and the new `slugify` keep letters of every script (they used to drop them, so Japanese, Chinese and Korean names compared as empty). `normalizeName` and `stripLegalForms` remove legal forms such as GmbH, AG, KG, SARL, S.p.A., Ltda, 株式会社, (株), 有限公司, 주식회사, (주) and the half-width カ) of Japanese bank-transfer names. `stripLegalTail` removes forms that only count at the end of a name (S.L., S.L.U., S.A.U., S.A. de C.V., S/A, ME, EPP, S.n.c., SE), so a vendor called `SL Green` keeps its name.

```json
{ "files": { "exports/仕訳.csv": { "encoding": "shift_jis", "decimal": "." } } }
```

**Output language.** `--lang de|fr|es|pt|it|ja|zh|ko` (or `MYTHOS_LANG`) sets the language of the pages and reports people read: the approvals page (which also has a language switcher), the Olympus readiness report, and the Ladon recertification summary and evidence page; a tool argument `language` overrides it per call where offered. Tool results, codes, CSV columns and JSON stay in English, so scripts and later runs read them the same. Any string not yet translated falls back to English. Use `makeText(catalog, lang)` and `coreText(lang)` for a pack's own pages.

**Limits.** The translations were written by Claude and have not been reviewed by native speakers; every translated page says so. The encoding guess can be wrong on very short files; set `encoding` when names look garbled. The column dictionaries cover common names, not every system's labels. The agents make no claim about any country's laws, tax rules or filing formats.

## Paid tier (licence keys)

A tool marked `tier: 'pro'` (optionally with a `feature` name) runs only with a valid licence key. Without one it returns `status: 'needs_license'` with the reason; free tools keep working. The check runs after the policy, so a blocked tool stays blocked, an `ask` tool still asks, nothing is put on Auto and one-click categories are untouched; no approval is requested for a call that cannot run.

A key is `MYTHOS1.<payload>.<Ed25519 signature>` with licensee, plan, agents (`*` or package names), features, issue and expiry dates. It is checked offline against the public keys in `src/license-keys.js` (empty in this release, so nothing can be unlocked yet). There is no environment variable or config file that adds a trusted key.

- Customer: `<pack> license install key.txt` (copies it to `.mythos/license.key`), `<pack> license status`, or set `MYTHOS_LICENSE` / `MYTHOS_LICENSE_FILE`. `mythos_info` shows the plan, expiry and which tools are unlocked, never the key.
- Seller, on their own computer: `npx -p mythos-agent-core mythos-license keygen --out ~/mythos-licence-keys`, paste the printed public key into `LICENSE_PUBLIC_KEYS`, release, then `mythos-license issue --key ~/mythos-licence-keys/private.pem --licensee "Customer" --plan pro --days 365 [--agents ladon-of-access] --out customer.key` and `mythos-license verify customer.key --pubkey ~/mythos-licence-keys/public.pem`. Withdrawn licence ids go in `LICENSE_REVOKED_IDS` and take effect from the next release.
- `ctx.license` gives a handler `{ status, valid, plan, features, has(feature) }`.

This is not copy protection: the packages are MIT-licensed source and anyone can remove the check. It draws a clear line for honest customers.

## What the model pin means

The manifest declares which host model a pack's prompts and evals target. An MCP server cannot force your MCP host to use that model; the pin is reported in `initialize` and `mythos_info` so you can check it. The wave-1 packs' tools are deterministic and call no model at all.

## Packs built on this core

All 30 Mythos domain agents in the monorepo, from `olympus-of-migration` to `solon-of-clauses`. Source: <https://github.com/fpavia111-creator/mythos-agents>.

## License

MIT © 2026 Kurt Francisco
