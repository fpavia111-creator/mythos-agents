# Echo of Docs (`echo-of-docs`)

> Finds where a package's README, docs and skills no longer match its tools, input schemas, OpenAPI spec, CHANGELOG and package.json, runs as a CI gate with SARIF output, and drafts low-risk fixes as copies. Publishing docs is one human click. Never overwrites docs.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Point Echo at a package folder and, ideally, its tool list: an MCP `tools/list` result, `mythos_info` output, or a plain array. It reads `README.md`, `SKILL.md`, `docs/` and `skills/`, and reports drift with the file and line:
- **tools**: tools in the code that no doc mentions; tools in the docs (tables, backticks, `call` examples) that no longer exist, with the nearest real name when one is one or two letters off; allow/ask/block labels that differ from the tool list; one-click tools whose docs do not say so; "N tools" counts that are wrong;
- **examples**: `call <tool> '{...}'` examples with invalid JSON, parameters the input schema does not have, or required parameters left out; `npm run` scripts that do not exist; `npx` for a package with no bin;
- **package.json**: version pins (`name@x.y.z`), "Node ≥ N" and the License section that differ from package.json;
- **links**: relative links to missing files and `#anchors` that match no heading (GitHub-style slugs);
- **skills**: `SKILL.md` without frontmatter, without a description, or with a name that is not lowercase-hyphenated;
- **OpenAPI** (pass `openapi`, a spec as JSON): endpoints in the docs (`GET /notes/{id}`, `curl -X DELETE https://…/notes/1`) that the spec does not have or has with another method, spec operations no doc mentions, and deprecated operations documented without saying so. The server base path is stripped and `{id}` matches a concrete `/notes/42`;
- **changelog**: a `CHANGELOG.md` with no entry for the package.json version, entries newer than it, or two entries for one version (`require_changelog` also flags a package with none).

For CI, `echo_ci` writes `echo-of-docs.sarif` (SARIF 2.1.0 for code scanning) and `drift.json`, and decides pass or fail from `fail_on` (`error` by default, or `warning`, `any`, `none`). Give it an earlier `drift.json` as `baseline` to see new and fixed findings, and `new_only` to fail on new drift only; fingerprints ignore line numbers, so moving text does not count as new. The `echo-of-docs ci` command exits 1 when the gate fails. Settings can live in a config file checked against the `docs_config` schema (`echo-of-docs validate-config docs_config echo.config.json`).

With approval it writes fixed **copies** for mechanical fixes only (version pins and unambiguous tool-name typos), within caps (`max_fixes`, default 20; `max_per_file`, default 10). Everything else is listed for a person. Because only copies are written, there is nothing to roll back.

## Install

```bash
npm install -g echo-of-docs
echo-of-docs demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add echo-of-docs -- npx -y echo-of-docs@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "echo-of-docs": { "command": "npx", "args": ["-y", "echo-of-docs@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `echo_check` | **allow** | Drift findings with severity, file and line; reads files only |
| `echo_write_report` | **allow** | Write `docs-drift.md` and `drift.csv` to `mythos-out/echo` |
| `echo_ci` | **allow** | CI gate: write `echo-of-docs.sarif` and `drift.json`, pass or fail by `fail_on`, compare with a `baseline` |
| `echo_draft_fixes` | **ask (Auto-eligible)** | Write fixed copies to `mythos-out/echo/proposed` within caps, plus `changes.md` and `proposal.json` (your docs untouched) |
| `echo_request_publish` | **ask · one-click** | After a named human approves, record the proposal (bound to its hash; originals must be unchanged) for whoever publishes |
| `write_docs` | **block** | Listed so agents see the refusal. Echo never overwrites docs in place. |
| `git_push` | **block** | Listed so agents see the refusal. Echo never commits, pushes or publishes. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `echo-of-docs approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`echo-of-docs kill`).

The check and `echo_ci` can run on every push, and `echo_draft_fixes` can go on Auto within its caps. Publishing docs is a `production_deploy`: it stays **one-click even in Auto**, and `--auto echo_request_publish` is refused. The approval is tied to the proposal's hash, every proposed file is re-hashed, and the original docs must not have changed since the proposal. Overwriting and pushing stay **blocked**.

Get a tool list for any MCP server by saving its `tools/list` response (add a `prompts` array from `prompts/list` so prompt names are not mistaken for tools), or for a Mythos pack with `<pack> mcp` and a `tools/list` request.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## GitHub Action

`action.yml` in this folder is a composite action that runs `echo-of-docs ci` with `npx`, writes the SARIF and fails the job on drift. `examples/docs-drift.yml` is a workflow that saves an MCP server's tool list, runs the action and uploads the SARIF to code scanning:

```yaml
- uses: fpavia111-creator/mythos-agents/packages/echo-of-docs@main
  id: echo
  with:
    pack: .
    tools: tools.json
    fail-on: error
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: ${{ steps.echo.outputs.sarif }}
```

Inputs: `pack`, `tools`, `openapi`, `config`, `fail-on`, `baseline`, `new-only`, `require-changelog`, `out-dir`, `version`. The action only reads the repository and writes into `out-dir`; it never commits or pushes.

## CLI

```bash
echo-of-docs tools
echo-of-docs call echo_check '{"pack":".","tools":"tools.json"}'
echo-of-docs call echo_check '{"pack":".","openapi":"openapi.json","require_changelog":true}'
echo-of-docs call echo_draft_fixes '{"pack":".","tools":"tools.json","max_fixes":5}'
echo-of-docs ci --pack . --tools tools.json --fail-on error      # exit 1 on drift
echo-of-docs ci --pack . --baseline old/drift.json --new-only     # fail on new drift only
echo-of-docs eval          # private evals on the bundled fixtures
```

### MCP prompt

`docs_drift_review` (arguments: `pack`, optional `tools` and `openapi`) walks a host model through getting a tool list, checking, reporting, drafting fixes and the one-click publish a named person approves.

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- It does not judge whether the prose is right or complete. "No drift found" means these checks passed, not that the docs are complete.
- It does not run your package, so behaviour that differs from the docs without a name, label, schema or version changing is not caught.
- It never rewrites prose, tables or examples, and never overwrites a file in place.
- OpenAPI specs must be JSON (there is no YAML parser), and endpoints are found by `METHOD /path` text and `curl -X` lines, so an endpoint described only in prose is not seen. It does not check request or response shapes.
- The changelog check looks for a heading with the version; it does not judge what the notes say.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are a fictional pack.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/echo-of-docs>
