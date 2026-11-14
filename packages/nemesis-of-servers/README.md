# Nemesis of Servers (`nemesis-of-servers`)

> Review one MCP or Code Mode server's source, or an MCP client config, for risky patterns before you ship or install it. Never runs it.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Nemesis reads a server folder (JS/TS/Python, `package.json`, tool docs) and flags, with file and line:
- shell execution, and exec with no visible allowlist; `eval` / `new Function` and Code Mode style code execution without a sandbox;
- dumping `process.env`, reading credential paths (`~/.ssh`, `~/.aws`, `.env`), hard-coded secrets (values masked);
- prompt-injection text and invisible Unicode in tool descriptions and docs;
- outbound requests to arbitrary URLs, plain `http://`, file writes and reads without a root check, write tools with no approval step;
- install scripts, unpinned (`*`, `latest`) and git/URL dependencies.

For an MCP client config (`mcpServers`) it flags unpinned `npx`/`uvx` packages and `@latest`, `curl | sh`, shell wrappers, `sudo`, broad Docker flags, `/` or home passed as a root, inline secrets and bearer tokens (values never shown) and plain-http remotes.

Its sibling **Argus** audits the setup already installed on a machine. Nemesis reviews one server before you ship or install it, and writes SARIF for code-scanning tools.

## Install

```bash
npm install -g nemesis-of-servers
nemesis-of-servers demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add nemesis-of-servers -- npx -y nemesis-of-servers@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "nemesis-of-servers": { "command": "npx", "args": ["-y", "nemesis-of-servers@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `nemesis_scan_server` | **allow** | Scan a server folder |
| `nemesis_scan_config` | **allow** | Review an MCP client config |
| `nemesis_write_report` | **allow** | Write `nemesis-report.md`, `findings.json`, `nemesis.sarif` to `mythos-out/nemesis` |
| `nemesis_run_server` | **block** | Listed so agents see the refusal. Nemesis never installs, starts or deploys code. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `nemesis-of-servers approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`nemesis-of-servers kill`).

All tools are read or report, so Auto changes nothing here. Running or deploying the server stays **blocked** in every mode.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
nemesis-of-servers tools
nemesis-of-servers call nemesis_scan_server '{"dir":"my-mcp-server","min_severity":"medium"}'
nemesis-of-servers eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not a security certification or a guarantee a server is safe. It is static and pattern-based: obfuscated, minified or dynamic code can hide behaviour, and some findings will be false positives.
- It does not run the server, test it, or check packages against vulnerability databases.
- `no_pattern_findings` means none of its patterns matched, not that the server was proven safe.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/nemesis-of-servers>
