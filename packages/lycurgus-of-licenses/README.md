# Lycurgus of Licenses (`lycurgus-of-licenses`)

> Applies your written license policy to an npm, pnpm, yarn, Python or Go project's dependencies, writes a report, SBOM, SARIF and a third-party notices draft, and fails the check without changing files. Publishing a release is one human click. Helps you apply your policy; not legal advice.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Point Lycurgus at a project and your license policy (a small JSON file: allow, review and deny lists with `*` patterns, what to do with unknown and proprietary licenses, whether dev dependencies count, and exceptions with an approver and an expiry date). It reads:

| Project | Lockfile | Licenses come from |
|---|---|---|
| npm | `package-lock.json` (v1–v3), or `node_modules` | the lockfile, then each installed `package.json` |
| pnpm | `pnpm-lock.yaml` (v6–v9) | installed `package.json` files (`modules_dir`, default `node_modules`, including `.pnpm`) |
| yarn | `yarn.lock` (classic and Berry) | installed `package.json` files |
| Python | `poetry.lock`, `uv.lock` or `requirements.txt` | `*.dist-info/METADATA` in site-packages (`License-Expression`, `License`, then trove classifiers) |
| Go | `go.mod`, or `vendor/modules.txt` | license files under `vendor/` (Go modules carry no license metadata) |

pnpm, yarn, Python and Go lockfiles do not record licenses, so the packages have to be installed (or vendored) for Lycurgus to read them; a package it cannot read is `unknown`, never allowed. For every dependency it reports:
- the declared license, read as an **SPDX expression** (`OR` takes the best option, `AND` the strictest, `WITH` exceptions only match entries that name them), with common spellings like "Apache 2.0" normalised and flagged;
- a decision, **allow**, **review**, **unknown** or **deny**, with the policy section it comes from;
- exceptions applied, expired, missing an approver, expiring within 30 days or left over for a package that is gone; packages with no license, `UNLICENSED` or `SEE LICENSE IN` a custom file; lockfile and installed package disagreeing; your own project missing a license field or LICENSE file. Workspace links, editable installs and locally replaced Go modules are skipped.

**License texts.** When a package declares no license (or points at a custom file), Lycurgus reads its license file and compares it with standard texts: MIT, ISC, 0BSD, BSD-2-Clause, BSD-3-Clause and the Unlicense word by word; Apache-2.0 and MPL-2.0 against a fingerprint of the official text; the GPL family and CC-BY-4.0 by title only.
- A **close match** (nearly all of the standard text, and almost nothing else) is used as the license and flagged `license_from_text`.
- A **low-confidence match** (changed or extra wording such as an added restriction, a truncated file, or a title-only match) is **never allowed**: it goes to review, or stays denied if your policy denies that license (`license_text_low_confidence`).
- No match stays `unknown`.
- When metadata declares one license and the license file closely matches another, it says so (`license_text_mismatch`); the declared license still decides.

**Third-party notices.** `lycurgus_write_notices` drafts `THIRD-PARTY-NOTICES.md` and `attribution.csv`: every shipped dependency your policy lets through, with its license, the copyright lines and license text from its installed license files (identical texts printed once) and any `NOTICE` file. A package is left out only when all its licenses are on your policy's `attribution.not_required` list (default: `0BSD`, `Unlicense`, `CC0-1.0`, `WTFPL`, `LicenseRef-Public-Domain`, `UNLICENSED`). A package with no license file locally gets a `[TO ADD]` marker instead of a guessed text. It is a draft for a person.

**What changed.** `lycurgus_diff_sbom` compares the SBOM from your last release with the project now: dependencies added and removed, version changes, license changes (a dependency that relicensed on upgrade), and which of those your policy does not allow.

The result is `pass`, `pass_with_review` or `fail`. It writes `license-report.md`, `licenses.csv`, a **CycloneDX 1.5** SBOM (npm, PyPI and Go purls), **SARIF 2.1.0** for code scanning (pointing at the lockfile line), `check-summary.json` with the lockfile and policy hashes, and `exceptions.ics` with exception expiry dates. The report's hash is recorded in the audit line. With approval it drafts exception stubs (no approver filled in, so they do not apply until a person signs them) and a review list. It never edits `package.json`, the lockfile, `node_modules` or your policy.

## Install

```bash
npm install -g lycurgus-of-licenses
lycurgus-of-licenses demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add lycurgus-of-licenses -- npx -y lycurgus-of-licenses@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "lycurgus-of-licenses": { "command": "npx", "args": ["-y", "lycurgus-of-licenses@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `lycurgus_check` | **allow** | Decisions per dependency with the policy section; `pass`, `pass_with_review` or `fail` |
| `lycurgus_write_report` | **allow** | Write the report, `licenses.csv`, `sbom.cdx.json`, `results.sarif`, `check-summary.json` and `exceptions.ics` to `mythos-out/lycurgus` |
| `lycurgus_write_notices` | **allow** | Write a `THIRD-PARTY-NOTICES.md` draft and `attribution.csv` to `mythos-out/lycurgus`; the project is not changed |
| `lycurgus_diff_sbom` | **allow** | Compare an earlier CycloneDX SBOM with the project now |
| `lycurgus_draft_exceptions` | **ask (Auto-eligible)** | Write `exceptions-proposed.json` (unsigned stubs) and `review-list.md`; policy and project untouched |
| `lycurgus_request_release` | **ask · one-click** | After a named human approves, record the release (bound to the check summary hash; lockfile and policy re-hashed). Refused when the check failed |
| `write_lockfile` | **block** | Listed so agents see the refusal. Lycurgus never changes project files. |
| `npm_publish` | **block** | Listed so agents see the refusal. Lycurgus never publishes. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

### MCP prompt

`lycurgus_license_review` (arguments `project`, `policy`, optional `baseline`, `as_of`) walks the host model through validating the policy, the check, license-text findings, the diff against the last release, the report and notices, exception stubs and the one-click release.

### Policy file

The policy is checked against a JSON Schema (`license_policy`): an unknown key such as `alow`, a wrong type or a missing `source` fails with a JSON pointer (`/alow is not an allowed property`). Check it on its own with `lycurgus-of-licenses validate-config license_policy license-policy.json`. Optional `attribution.not_required` lists the licenses your policy says need no notices entry.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `lycurgus-of-licenses approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`lycurgus-of-licenses kill`).

The check and report can run on every push, and `lycurgus_draft_exceptions` can go on Auto. Publishing a release is a `production_deploy`: it stays **one-click even in Auto**, and `--auto lycurgus_request_release` is refused. The approval is tied to the check summary's hash; the lockfile and policy are re-hashed, a failed check is refused, and a pass with review items needs a `review_note` naming who reviewed them. Changing lockfiles and publishing stay **blocked**.

### In CI

```bash
npx -y lycurgus-of-licenses@0.2.0 check --project . --policy license-policy.json
# other lockfiles are detected; flags: --ecosystem pnpm|yarn|python|go, --modules-dir, --site-packages, --include-dev
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
- It reads the license each package declares in its metadata and, where it can, the package's top-level license files. It does not scan source files, file headers or vendored code inside a package, so terms that appear only there are not seen.
- Text matching knows a small set of standard texts (listed above). Anything else is `unknown`. The GPL family is recognised by title only, and a license text cannot say "only" or "or later", so those matches are always low confidence. A close match says the file reads like the standard text; it does not say what the license allows.
- The notices file is a draft. It does not decide what any license requires, and `[TO ADD]` entries are not filled in for you.
- npm, pnpm, yarn, Python (Poetry, uv, requirements.txt) and Go. No Maven, Gradle, Cargo, NuGet or Composer. `requirements.txt` has no dev groups and only lists what you pinned; Go has no dev dependencies in `go.mod`. The pnpm and yarn readers cover the usual lockfile shapes, not every setting.
- For pnpm, yarn, Python and Go the packages must be installed or vendored locally; Lycurgus never downloads anything.
- Not a replacement for a full software-composition-analysis product, and not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional projects and a fictional policy. `src/license-fingerprints.json` holds hashes of the official Apache-2.0 and MPL-2.0 texts (not the texts themselves).

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/lycurgus-of-licenses>
