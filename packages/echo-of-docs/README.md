# Echo of Docs (`echo-of-docs`)

> Finds where a package's README, docs and skills no longer match its tools, input schemas and package.json, and drafts low-risk fixes as copies. Publishing docs is one human click. Never overwrites docs.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Point Echo at a package folder and, ideally, its tool list: an MCP `tools/list` result, `mythos_info` output, or a plain array. It reads `README.md`, `SKILL.md`, `docs/` and `skills/`, and reports drift with the file and line:
- **tools**: tools in the code that no doc mentions; tools in the docs (tables, backticks, `call` examples) that no longer exist, with the nearest real name when one is one or two letters off; allow/ask/block labels that differ from the tool list; one-click tools whose docs do not say so; "N tools" counts that are wrong;
- **examples**: `call <tool> '{...}'` examples with invalid JSON, parameters the input schema does not have, or required parameters left out; `npm run` scripts that do not exist; `npx` for a package with no bin;
- **package.json**: version pins (`name@x.y.z`), "Node ≥ N" and the License section that differ from package.json;
- **links**: relative links to missing files and `#anchors` that match no heading (GitHub-style slugs);
- **skills**: `SKILL.md` without frontmatter, without a description, or with a name that is not lowercase-hyphenated.

With approval it writes fixed **copies** for mechanical fixes only (version pins and unambiguous tool-name typos), within caps (`max_fixes`, default 20; `max_per_file`, default 10). Everything else is listed for a person. Because only copies are written, there is nothing to roll back.

## Install

```bash
npm install -g echo-of-docs
echo-of-docs demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add echo-of-docs -- npx -y echo-of-docs@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "echo-of-docs": { "command": "npx", "args": ["-y", "echo-of-docs@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `echo_check` | **allow** | Drift findings with severity, file and line; reads files only |
| `echo_write_report` | **allow** | Write `docs-drift.md` and `drift.csv` to `mythos-out/echo` |
| `echo_draft_fixes` | **ask (Auto-eligible)** | Write fixed copies to `mythos-out/echo/proposed` within caps, plus `changes.md` and `proposal.json` (your docs untouched) |
| `echo_request_publish` | **ask · one-click** | After a named human approves, record the proposal (bound to its hash; originals must be unchanged) for whoever publishes |
| `write_docs` | **block** | Listed so agents see the refusal. Echo never overwrites docs in place. |
| `git_push` | **block** | Listed so agents see the refusal. Echo never commits, pushes or publishes. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `echo-of-docs approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`echo-of-docs kill`).

The check can run on every push, and `echo_draft_fixes` can go on Auto within its caps. Publishing docs is a `production_deploy`: it stays **one-click even in Auto**, and `--auto echo_request_publish` is refused. The approval is tied to the proposal's hash, every proposed file is re-hashed, and the original docs must not have changed since the proposal. Overwriting and pushing stay **blocked**.

Get a tool list for any MCP server by saving its `tools/list` response, or for a Mythos pack with `<pack> mcp` and a `tools/list` request.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
echo-of-docs tools
echo-of-docs call echo_check '{"pack":".","tools":"tools.json"}'
echo-of-docs call echo_draft_fixes '{"pack":".","tools":"tools.json","max_fixes":5}'
echo-of-docs eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- It does not judge whether the prose is right or complete. "No drift found" means these checks passed, not that the docs are complete.
- It does not run your package, so behaviour that differs from the docs without a name, label, schema or version changing is not caught.
- It never rewrites prose, tables or examples, and never overwrites a file in place.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are a fictional pack.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/echo-of-docs>
