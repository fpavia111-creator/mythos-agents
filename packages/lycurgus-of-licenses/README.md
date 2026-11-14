# Lycurgus of Licenses (`lycurgus-of-licenses`)

> Applies your written license policy to an npm project's dependencies, writes a report, SBOM and SARIF, and fails the check without changing files. Publishing a release is one human click. Helps you apply your policy; not legal advice.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Point Lycurgus at an npm project and your license policy (a small JSON file: allow, review and deny lists with `*` patterns, what to do with unknown and proprietary licenses, whether dev dependencies count, and exceptions with an approver and an expiry date). It reads `package-lock.json` (v1–v3), falls back to each installed `package.json`, and for every dependency reports:
- the declared license, read as an **SPDX expression** (`OR` takes the best option, `AND` the strictest, `WITH` exceptions only match entries that name them), with common spellings like "Apache 2.0" normalised and flagged;
- a decision, **allow**, **review**, **unknown** or **deny**, with the policy section it comes from;
- exceptions applied, expired or missing an approver; packages with no license, `UNLICENSED` or `SEE LICENSE IN` a custom file; lockfile and installed package disagreeing; your own project missing a license field or LICENSE file. Workspace links are skipped.

The result is `pass`, `pass_with_review` or `fail`. It writes `license-report.md`, `licenses.csv`, a **CycloneDX 1.5** SBOM, **SARIF 2.1.0** for code scanning, and `check-summary.json` with the lockfile and policy hashes. With approval it drafts exception stubs (no approver filled in, so they do not apply until a person signs them) and a review list. It never edits `package.json`, the lockfile, `node_modules` or your policy.

## Install

```bash
npm install -g lycurgus-of-licenses
lycurgus-of-licenses demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add lycurgus-of-licenses -- npx -y lycurgus-of-licenses@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "lycurgus-of-licenses": { "command": "npx", "args": ["-y", "lycurgus-of-licenses@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `lycurgus_check` | **allow** | Decisions per dependency with the policy section; `pass`, `pass_with_review` or `fail` |
| `lycurgus_write_report` | **allow** | Write the report, `licenses.csv`, `sbom.cdx.json`, `results.sarif` and `check-summary.json` to `mythos-out/lycurgus` |
| `lycurgus_draft_exceptions` | **ask (Auto-eligible)** | Write `exceptions-proposed.json` (unsigned stubs) and `review-list.md`; policy and project untouched |
| `lycurgus_request_release` | **ask · one-click** | After a named human approves, record the release (bound to the check summary hash; lockfile and policy re-hashed). Refused when the check failed |
| `write_lockfile` | **block** | Listed so agents see the refusal. Lycurgus never changes project files. |
| `npm_publish` | **block** | Listed so agents see the refusal. Lycurgus never publishes. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `lycurgus-of-licenses approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`lycurgus-of-licenses kill`).

The check and report can run on every push, and `lycurgus_draft_exceptions` can go on Auto. Publishing a release is a `production_deploy`: it stays **one-click even in Auto**, and `--auto lycurgus_request_release` is refused. The approval is tied to the check summary's hash; the lockfile and policy are re-hashed, a failed check is refused, and a pass with review items needs a `review_note` naming who reviewed them. Changing lockfiles and publishing stay **blocked**.

### In CI

```bash
npx -y lycurgus-of-licenses@0.1.0 check --project . --policy license-policy.json
```

Prints the summary and exits `1` when the check fails (`0` otherwise). It changes no files. Upload `mythos-out/lycurgus/results.sarif` from `lycurgus_write_report` to show findings in code scanning.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
lycurgus-of-licenses tools
lycurgus-of-licenses call lycurgus_check '{"project":".","policy":"license-policy.json","include_dev":true}'
lycurgus-of-licenses call lycurgus_write_report '{"project":".","policy":"license-policy.json"}'
lycurgus-of-licenses eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not legal advice, and it does not decide what a license allows. It applies the lists you wrote. A pass means "matches your policy as written", not "cleared for distribution", and it does not make a project compliant with anything.
- It reads the license each package declares in its metadata. It does not scan source files, notices, vendored code or license texts, so a package that declares one license and ships another will not be caught.
- npm projects only (lockfile or `node_modules`).
- Not a replacement for a full software-composition-analysis product, and not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are a fictional project and a fictional policy.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/lycurgus-of-licenses>
