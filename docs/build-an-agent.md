# Build a Mythos agent

A Mythos agent owns one business process, runs on the buyer's machine, reads exports under `--root`, and cannot act outside its lane. This guide goes from nothing to a published package.

## 1. Scaffold

```bash
npx -y -p mythos-agent-core mythos-new-agent iris-of-tests --dir packages
```

Add `packages/iris-of-tests` to the root `workspaces`, run `npm install`, then `cd packages/iris-of-tests && npm test`. The scaffold passes `npm test`, `eval` and `npm pack --dry-run` as generated.

Check the name is free first: `curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/iris-of-tests` must print `404`.

## 2. Write the manifest

`src/manifest.js` is the whole contract:

- `tools`: each has `name`, `kind` (`read`, `report`, `write`, `action`), `description`, an accurate `inputSchema` (the runtime validates every call against it), an optional `title`, and a `handler(args, ctx)`.
- `policy.rules`: one rule per tool (`allow`, `ask`, `block`), ending with `{ tool: '*', decision: 'block' }`. Writes and actions can never be `allow`.
- One-click categories (`go_live`, `revoke_access`, `delete_personal_data`, `move_money`, `binding_send`, `production_deploy`, `accept_learning`) are `ask` (a named person approves) or `block`. They can never go on Auto.
- List refused tools (`send_email`, `erp_post_invoice`, …) as `block` so a host model sees they exist and are refused.
- `prompts`: an MCP prompt that walks a host model through the workflow.
- `configSchemas`: a JSON Schema per config file; load configs with `ctx.readJson(path, 'name')`.

Keep domain logic pure in `src/<domain>.js` and do all file access through `ctx` (`records`, `readText`, `readJson`, `outDir`, `writeFile`), which refuses paths outside `--root`, including through symlinks.

## 3. The draft → request → one click pattern

1. A `write` tool drafts files into `mythos-out/<agent>/` and returns their sha256.
2. An `action` tool in a one-click category re-hashes the draft, refuses if it changed or still holds `[TO CONFIRM]` markers, then returns `needs_approval`.
3. A person approves (CLI, `approvals serve` page, or a signed webhook) and the same call runs once.

## 3b. Treat file contents as hostile

The runtime does most of this for you (see "Untrusted data and broken arguments" in the core README). What is left to the agent:

- Escape every value you put into HTML with `escapeHtml`. `htmlPage` handles the page shell, table wrapping and header scopes.
- Build file names from data with `safeFileName(id)`. `ctx.writeFile` refuses a name that leaves its folder, but a refused write fails the whole call.
- Write files through `ctx.writeFile`, not `writeFileSync`, so Markdown goes through `safeMarkdown` and paths are checked.
- If you record a hash of a Markdown file, hash `safeMarkdown(text)` (it is idempotent) or the file on disk, not the text you built.
- Give numeric arguments a `maximum`. A loop bounded by a caller's number is a hang waiting to happen.
- Run `npm run hostile` from the repo root before you open a pull request; CI runs it too.

## 4. Fixtures, tests, evals

- Fixtures are fictional: `example.com`, `.test`, `555` numbers, invalid TINs, made-up names.
- `test/*.test.js` with `node:test`. Approvals are single-use and bound to arguments, so use different args in each approval test.
- `evals/cases.json`: tool-level cases with `expect.status`, `contains`, `equals`, `matches`, `min`, `max`, `length`. Run `node bin/<agent>.js eval --report eval-out/` for an offline HTML report; add `--baseline` to fail on regressions.

## 4b. Read the exports people already have

If a tool takes a table, declare it under `sources` so real exports work without hand mapping: the agent's own columns (`fields`, each with a `type` of text, date, datetime, money, number, bool or email, and `aliases`), the arguments that carry that kind of file (`args`), and `profiles` built with `exportProfile('<catalogue id>', { field: 'Their Column' })`. Read files with `ctx.records(a.arg)` (or `ctx.records(path, 'kind')` when the argument name does not say). Add the catalogue entry to `mythos-agent-core/src/exports.js` if the export is new, with `basis: 'documented'`, `source` and `checked` only when you compared its columns with the vendor's documentation; otherwise leave it `recalled`. Put a fictional sample of each export in `fixtures/exports/`, test that it gives the same result as the native fixture, and run `node scripts/sources-doc.mjs` to regenerate the README section. A profile `note` says what the export lacks (no last-login column, no unit cost): say it plainly rather than guess.

Files from other markets come for free: the core decodes legacy encodings, reads local amounts and dates, and fills still-unmatched fields from its column-name dictionary (eight languages, about 100 concepts, keyed by field name). Name your fields after a concept in `mythos-agent-core/src/i18n/columns.js` (`amount`, `email`, `vendor`...) to get those names; set `translate: 'ledger_debit'` to borrow another concept's names, or `translate: false` when a field's local names would mislead (a bank's money-out column is not a ledger debit). If a new concept is needed, add it with names in all eight languages; the core test fails on a missing one. Compare names and words with `normalizeName`, `foldText` and `normHeader`, never with `[^a-z0-9]`, which deletes Japanese, Chinese and Korean text, and build file names with `safeFileName` or `slugify` plus `uniqueNames`. A regex with `\b` never matches next to CJK characters; see `roleRe` in Ladon for a version that does.

## 4c. Pages people read, in their language

If the agent writes a report or page for people, keep its words in a catalog (`{ key: { en, de, fr, es, pt, it, ja, zh, ko } }`) and read them through `makeText(catalog, lang)`, with `lang = normLang(a.language || ctx.lang)`. Offer a `language` argument (`enum: LANGS`) on the report tool. Keep codes, CSV columns, JSON and anything a later run reads in English, keep every limitation sentence in every language, and add the catalog's `translation_note` to non-English output. Test that every key exists in all nine languages with the same `{placeholders}`, and that the English output did not change. Olympus (`src/text.js`) and Ladon are the worked examples.

## 4d. Paid tools

Mark a tool `tier: 'pro'` (and optionally `feature: 'name'`) only when the owner has decided the tier list and a trusted public key is in `license-keys.js`. The licence gate never changes a policy decision; do not use it as a safety control.

## 4e. Domain memory (optional)

Give an agent memory only when the same customer facts are typed again on every run (a column name, a role that counts as privileged). Declare the kinds in `src/memory.js`:

- Each kind has a `description` with an example, an `effect` that says in plain words what an accepted fact changes, a closed JSON Schema (`additionalProperties: false`) and, if the schema cannot say it, a `check(value)` that returns a reason to refuse.
- **Only add kinds that add to a check** (another role, another rule) or fill in something the call and config leave unset. Never make a threshold, tolerance, rate or allowlist learnable: a remembered number can hide a difference. Policy, caps and Auto are not memory.
- Spread `memoryTools('<prefix>', KINDS)` into `tools` and `policy.rules`, and set `memory: { prefix, kinds }` in the manifest. `defineManifest` checks the four tools are there.
- In handlers, read accepted facts with `ctx.memoryFacts(kind)` after the call's arguments and config are merged, let the arguments and config win, and say which facts were used and which were skipped (and why) in the result and any report. The runtime adds `memory_applied` and the audit ids for you.
- Test: a waiting fact changes nothing, an accepted one does, the config wins, a loosening kind is refused, and `memory: false` runs without it. Ladon and Olympus are the worked examples.

## 5. Connect a host

```jsonc
// Claude Code: .mcp.json in your project
{ "mcpServers": { "iris": { "command": "npx", "args": ["-y", "iris-of-tests", "mcp", "--root", "."] } } }
```

```jsonc
// Claude Desktop: claude_desktop_config.json
{ "mcpServers": { "iris": { "command": "npx", "args": ["-y", "iris-of-tests", "mcp", "--root", "/path/to/exports"] } } }
```

```jsonc
// Cursor: .cursor/mcp.json   |   VS Code: .vscode/mcp.json uses "servers" instead of "mcpServers"
{ "mcpServers": { "iris": { "command": "npx", "args": ["-y", "iris-of-tests", "mcp", "--root", "."] } } }
```

Give the host the MCP server only, not a shell in the same folder, so approvals mean something. For stronger evidence, start the server with `--signing-key` (a key kept outside `--root`) and keep an `--audit-mirror`.

## 6. Release checklist

Run `npm run release:check` (or `release:check:offline`). It is a dry run: name and version on npm, package metadata and changelog section, git state, no `.npmrc`, secret scan of tracked and packed files, banned-claims scan of READMEs and manifests, one-click policy, tests, evals, the hostile-input run, and `npm pack --dry-run` contents. It writes `mythos-out/release-check/release-check.md` and prints the publish commands in order (core first) with a throwaway npm userconfig that reads `NPM_TOKEN` from the environment. It never publishes. Then: tests on Node 20, 22 and 24 and on Windows (the CI matrix), back up the website deploy folder and note the Pages deployment id, and publish yourself.
