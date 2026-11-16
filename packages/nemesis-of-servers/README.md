# Nemesis of Servers (`nemesis-of-servers`)

> Review one MCP or Code Mode server's source, its saved tool definitions, or an MCP client config for risky patterns before you ship or install it. Never runs it.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Nemesis is static and offline. It reads files you give it under `--root`; it never installs, starts or connects to the server.

**Server source** (JS/TS/Python, `package.json`, lockfile, `requirements.txt`, tool docs), with file and line:
- shell execution, and exec with no visible allowlist; `eval` / `new Function` and Code Mode style execution without a sandbox; SQL built from templates; `pickle` / `yaml.load`;
- dumping `process.env`, credential paths (`~/.ssh`, `~/.aws`, `.npmrc`), hard-coded secrets (values masked);
- prompt-injection text and invisible Unicode in tool descriptions and docs;
- outbound requests, plain `http://`, TLS checks turned off, servers bound to `0.0.0.0`, `Access-Control-Allow-Origin: *`, file writes without a root check or approval step;
- **data flows (taint-style, one file at a time):** a secret (key-like environment variable, the whole environment, or a credential file) → body or URL of a network call; incoming `Authorization` header → upstream call (token passthrough); tool input → exec/eval; tool input → file path; tool input → the URL of a network call (SSRF). Each finding shows the path, e.g. `line 5 apiKey = secret from the environment -> line 6 payload = ... -> line 9 sink: fetch`. Ordinary API-client code is left alone: a secret sent as an auth header, config such as `BASE_URL` or `PORT` from the environment, tool input placed after a fixed host or in a request body. Calls to guards such as `safePath(...)`/`inside(...)` and allowlist checks (`ALLOWLIST.includes(cmd)`) are respected;
- **supply chain:** install scripts, unpinned (`*`, `latest`) and git/URL dependencies, dependencies with no lockfile, lockfile entries resolved outside the npm registry or without an integrity hash, unpinned Python requirements, and versions that match an **offline advisory list** (a small bundled snapshot plus any list you supply).

**Saved tool definitions** (the JSON of a `tools/list` result, which you capture yourself, for example with the MCP Inspector CLI): hidden instructions (`<IMPORTANT>`, "do not tell the user"), coercive wording, invisible Unicode and whitespace padding, credential-file lures, requests for chat history or file contents, **tool shadowing** (one server's text changing how another server's tool behaves, e.g. adding a BCC), name collisions across servers, look-alike (non-ASCII) names, free-form `command`/`code`/`sql` parameters, and `readOnlyHint: true` on tools named delete/send/run.

**Rug pulls:** `nemesis_pin_tools` records a sha256 and the reviewed text for every tool; `nemesis_check_pins` compares a later `tools/list` with the pins and shows a unified diff of each changed description, schema or annotation. A change that adds poisoning text is high (`rug_pull_suspected`).

**MCP client config** (`mcpServers`): unpinned `npx`/`uvx` packages and `@latest`, advisory matches, `curl | sh`, shell wrappers, `sudo`, broad Docker flags, `/` or home passed as a root, permission-bypass flags (`--dangerously-skip-permissions`, `--allow-all`, `--no-sandbox`), auto-approved tools (`alwaysAllow`, `autoApprove`, `trust: true`), duplicate servers, inline secrets and bearer tokens (values never shown) and plain-http remotes.

**Reports:** `nemesis-report.md` with a prioritised **Fix first** list (grouped by rule, with what to do), the data-flow paths, the tool diff and an OWASP MCP Top 10 view; `findings.json`; and `nemesis.sarif` (SARIF 2.1.0 for GitHub code scanning and other SARIF viewers) with rule help, CWE and OWASP MCP tags, `security-severity`, content-based fingerprints, `codeFlows` for data flows and policy suppressions with their justification. The SARIF is deterministic (no timestamps). An optional `fail_on` gives a pass/fail result for CI. The report's hash is written to the audit log (`output_sha256`), so a signed audit log (`--signing-key`) also signs which report was produced.

Its sibling **Argus** audits the setup already installed on a machine. Nemesis reviews one server before you ship or install it.

## Install

```bash
npm install -g nemesis-of-servers
nemesis-of-servers demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add nemesis-of-servers -- npx -y nemesis-of-servers@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "nemesis-of-servers": { "command": "npx", "args": ["-y", "nemesis-of-servers@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `nemesis_scan_server` | **allow** | Scan a server folder: patterns, data flows, lockfile, advisories |
| `nemesis_scan_config` | **allow** | Review an MCP client config |
| `nemesis_scan_tools` | **allow** | Check a saved `tools/list` result for tool poisoning, shadowing and risky schemas |
| `nemesis_pin_tools` | **allow** | Write `tool-pins.json` for reviewed tool definitions |
| `nemesis_check_pins` | **allow** | Compare a new `tools/list` with the pins (rug-pull check) |
| `nemesis_write_report` | **allow** | Write `nemesis-report.md`, `findings.json`, `nemesis.sarif` to `mythos-out/nemesis` |
| `nemesis_run_server` | **block** | Listed so agents see the refusal. Nemesis never installs, starts or deploys code. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

### Prompt

`nemesis_review_server` (MCP prompt) walks a host model through the whole review in order: config, source and data flows, tool definitions, pins, report, then stops for a human. Arguments: `dir` (required), `config`, `tools`, `policy`.

## Reviewer policy and advisory lists

A policy file records what a person reviewed and accepted. Suppressed findings are not dropped: they are listed with the reason in the result, the Markdown report and the SARIF (`suppressions`).

```json
{
  "egress_allowlist": ["api.example.com"],
  "ignore_paths": ["test/**"],
  "severity_overrides": { "NEM-LOCK-NO-INTEGRITY": "medium" },
  "suppress": [{ "rule": "NEM-BIND-ALL", "path": "src/server.js", "reason": "Runs only inside the container network", "reviewer": "A. Person" }],
  "advisories": "advisories.json",
  "fail_on": "high"
}
```

An extra advisory list (`advisories` argument, or `advisories` in the policy, relative to the policy file) uses `{ "advisories": [{ "id", "ecosystem": "npm"|"pypi", "package", "affected": ">=1.0.0 <1.4.0", "fixed", "severity", "summary", "url" }] }`. Both files are checked against JSON Schemas before use; a typo fails with a JSON-pointer path. Check a file yourself with:

```bash
nemesis-of-servers validate-config nemesis-policy my-policy.json
nemesis-of-servers validate-config nemesis-advisories my-advisories.json
nemesis-of-servers validate-config nemesis-tool-pins tool-pins.json
```

The bundled snapshot (`src/data/advisories.json`, dated) lists a few public advisories for MCP-related npm packages (for example `mcp-remote` CVE-2025-6514). It is a short hand-picked list, not a vulnerability database; keep running your usual dependency audit.

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
nemesis-of-servers call nemesis_scan_tools '{"tools":"tools-list.json"}'
nemesis-of-servers call nemesis_write_report '{"dir":"my-mcp-server","tools":"tools-list.json","fail_on":"high","uri_prefix":"servers/my-mcp-server/"}'
nemesis-of-servers eval          # private evals on the bundled fixtures
```

`uri_prefix` makes SARIF paths repository-relative when `--root` is not the repository root.

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## Rules

Every rule maps to the [OWASP MCP Top 10](https://owasp.org/www-project-mcp-top-10/) and a CWE. Severity is the default; a policy can override it.

| Rule | Severity | Finding | OWASP MCP | CWE |
|---|---|---|---|---|
| `NEM-EXEC-SHELL` | high | Runs shell commands | MCP05 | CWE-78 |
| `NEM-EXEC-NO-ALLOWLIST` | high | Runs commands with no visible allowlist in this file | MCP05 | CWE-78 |
| `NEM-EVAL` | high | Evaluates code from strings | MCP05 | CWE-95 |
| `NEM-CODEMODE-NOSANDBOX` | high | Code Mode execute without an isolated sandbox | MCP05 | CWE-94 |
| `NEM-ENV-DUMP` | high | Exposes the whole environment | MCP01, MCP10 | CWE-526 |
| `NEM-CRED-PATH` | high | Reads credential paths | MCP01 | CWE-522 |
| `NEM-HARDCODED-SECRET` | high | Hard-coded secret | MCP01 | CWE-798 |
| `NEM-INJECTION-TEXT` | high | Prompt-injection wording in tool text | MCP03, MCP06 | CWE-1427 |
| `NEM-INVISIBLE-UNICODE` | high | Invisible or bidi Unicode characters | MCP03 | CWE-1007 |
| `NEM-OPEN-EGRESS` | medium | Outbound network call | MCP10 | CWE-200 |
| `NEM-PLAIN-HTTP` | medium | Plain http:// URL | MCP07 | CWE-319 |
| `NEM-FS-WRITE` | medium | Writes or deletes files | MCP02 | CWE-73 |
| `NEM-NO-PATH-GUARD` | low | Path joined from input without a root check | MCP02 | CWE-22 |
| `NEM-WRITE-NO-APPROVAL` | medium | Writes without any approval hook in this file | MCP02 | CWE-862 |
| `NEM-TLS-DISABLED` | high | TLS certificate checks turned off | MCP07 | CWE-295 |
| `NEM-BIND-ALL` | medium | HTTP server listens on all interfaces | MCP07 | CWE-1327 |
| `NEM-CORS-ANY` | medium | CORS allows any origin | MCP07 | CWE-942 |
| `NEM-UNSAFE-DESERIALIZE` | high | Unsafe deserialization | MCP05 | CWE-502 |
| `NEM-SQL-CONCAT` | high | SQL built from a string template | MCP05 | CWE-89 |
| `NEM-TOKEN-PASSTHROUGH` | high | Forwards the client token to another service | MCP01, MCP07 | CWE-441 |
| `NEM-FLOW-ENV-TO-NET` | high | Secret flows into the body or URL of a network call | MCP01, MCP10 | CWE-201 |
| `NEM-FLOW-INPUT-TO-EXEC` | high | Tool input flows into command or code execution | MCP05 | CWE-78 |
| `NEM-FLOW-INPUT-TO-NET` | medium | Tool input flows into a network call (SSRF) | MCP10 | CWE-918 |
| `NEM-FLOW-INPUT-TO-PATH` | high | Tool input flows into a file path without a root check | MCP02 | CWE-22 |
| `NEM-INSTALL-SCRIPT` | medium | Has an install script | MCP04 | CWE-829 |
| `NEM-UNPINNED-DEP` | medium | Unpinned dependency | MCP04 | CWE-1104 |
| `NEM-URL-DEP` | medium | Dependency installs from a URL or git | MCP04 | CWE-829 |
| `NEM-NO-LOCKFILE` | medium | Dependencies with no lockfile | MCP04 | CWE-1104 |
| `NEM-LOCK-NONREGISTRY` | medium | Lockfile resolves a package outside the npm registry | MCP04 | CWE-829 |
| `NEM-LOCK-NO-INTEGRITY` | low | Lockfile entry has no integrity hash | MCP04 | CWE-353 |
| `NEM-PY-UNPINNED` | medium | Python requirement without an exact pin | MCP04 | CWE-1104 |
| `NEM-ADVISORY` | high | Dependency matches an advisory in the offline list | MCP04 | CWE-1395 |
| `NEM-CFG-PLAIN-HTTP` | high | Remote server over plain http | MCP07 | CWE-319 |
| `NEM-CFG-INLINE-TOKEN` | high | Bearer token written into the config | MCP01 | CWE-798 |
| `NEM-CFG-UNPINNED` | medium | Runs a package without a pinned version | MCP04 | CWE-1104 |
| `NEM-CFG-LATEST` | medium | Runs @latest | MCP04 | CWE-1104 |
| `NEM-CFG-PIPE-SH` | high | Pipes a download into a shell | MCP04 | CWE-494 |
| `NEM-CFG-SHELL-WRAP` | medium | Starts the server through a shell string | MCP05 | CWE-78 |
| `NEM-CFG-SUDO` | high | Runs with sudo | MCP02 | CWE-250 |
| `NEM-CFG-DOCKER-BROAD` | high | Docker with privileged mode, host network, root mount or the Docker socket | MCP02 | CWE-250 |
| `NEM-CFG-BROAD-ROOT` | high | Filesystem root or home folder passed as an argument | MCP02 | CWE-668 |
| `NEM-CFG-INLINE-SECRET` | high | Secret value written inline | MCP01 | CWE-798 |
| `NEM-CFG-AUTO-APPROVE` | high | Tools auto-approved in the client config | MCP02 | CWE-862 |
| `NEM-CFG-SKIP-PERMS` | high | Server started with a permission or sandbox bypass flag | MCP02 | CWE-250 |
| `NEM-CFG-DUPLICATE` | medium | Same server configured more than once | MCP09 | CWE-1188 |
| `NEM-CFG-ADVISORY` | high | Configured package matches an advisory in the offline list | MCP04 | CWE-1395 |
| `NEM-TOOL-INJECTION` | high | Instructions to the model hidden in tool text | MCP03, MCP06 | CWE-1427 |
| `NEM-TOOL-COERCIVE` | medium | Coercive wording in tool text | MCP03 | CWE-1427 |
| `NEM-TOOL-HIDDEN-UNICODE` | high | Invisible Unicode in tool text | MCP03 | CWE-1007 |
| `NEM-TOOL-PADDING` | medium | Tool text padded with long runs of whitespace | MCP03 | CWE-1007 |
| `NEM-TOOL-SENSITIVE-PATH` | high | Tool text mentions credential or config files | MCP03, MCP01 | CWE-522 |
| `NEM-TOOL-CONTEXT-EXFIL` | high | Tool text asks for the conversation, system prompt or file contents | MCP10 | CWE-200 |
| `NEM-TOOL-SHADOWING` | high | Tool text tries to change how other tools behave | MCP03 | CWE-1427 |
| `NEM-TOOL-ENCODED` | medium | Encoded blob in tool text | MCP03 | CWE-506 |
| `NEM-TOOL-LONG-DESC` | low | Very long tool description | MCP03 | CWE-1427 |
| `NEM-TOOL-NAME-COLLISION` | medium | Same tool name on more than one server | MCP09, MCP03 | CWE-1188 |
| `NEM-TOOL-CONFUSABLE-NAME` | medium | Tool name uses non-ASCII or look-alike characters | MCP03 | CWE-1007 |
| `NEM-TOOL-FREEFORM-EXEC` | medium | Free-form command or code parameter | MCP02, MCP05 | CWE-77 |
| `NEM-TOOL-ANNOTATION-MISMATCH` | high | Tool claims to be read-only but its name says it changes things | MCP02 | CWE-345 |
| `NEM-TOOL-NO-ANNOTATIONS` | low | State-changing tool has no annotations | MCP02 | CWE-1188 |
| `NEM-TOOL-CHANGED` | medium | Tool definition changed since it was pinned | MCP03, MCP04 | CWE-494 |
| `NEM-TOOL-ADDED` | low | Tool added since it was pinned | MCP04 | CWE-494 |
| `NEM-TOOL-REMOVED` | low | Tool removed since it was pinned | MCP04 | CWE-494 |

## What it is not

- Not a security certification or a guarantee a server is safe. It is static and pattern-based: obfuscated, minified or dynamic code can hide behaviour, and some findings will be false positives.
- The data-flow check follows named variables within one file. It does not follow calls across functions or files, so it can miss flows and can flag inputs that are checked elsewhere.
- It does not run the server, connect to it, call any model, or query vulnerability databases. The advisory list is a small offline snapshot plus what you supply.
- Tool annotations are hints from the server; Nemesis checks them for contradictions but cannot verify behaviour.
- `no_pattern_findings` means none of its patterns matched, not that the server was proven safe.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional (the sample servers are deliberately vulnerable and ship as non-runnable `.sample` files).

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/nemesis-of-servers>
