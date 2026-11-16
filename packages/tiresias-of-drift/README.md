# Tiresias of Drift (`tiresias-of-drift`)

> Compare config, schema, Terraform state and Kubernetes manifest snapshots over time and explain each drift with a risk level. Applying a fix to production is one human click.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Tiresias reads snapshots you already export: JSON or YAML config, `.env` / `.properties` files (`KEY=value`), schema CSVs (`table, column, type, nullable, default`), **Terraform state** (`.tfstate`, or `terraform state pull` output saved as JSON) and **Kubernetes manifests** (YAML or JSON, multi-document files and `kubectl get -o yaml` lists). It:
- lists every added, removed and changed key, highest risk first, with a plain reason (TLS or verification switched off, CORS or a CIDR opened to everyone, debug turned on, a secret changed, a column dropped, a type narrowed, nullability tightened…);
- **never shows secret values** (keys like password, token, api_key, secret are masked);
- walks a folder of dated snapshots and says when each key first drifted, plus net drift from first to latest;
- skips noisy keys you list in `ignore` (for example `meta.generated_at` or `build.*`);
- drafts a revert plan back to the earlier snapshot, as a proposal.

**Terraform state.** Changes are keyed by resource address (`aws_db_instance.billing.publicly_accessible`). Added and removed resources are one item each. Attributes listed in the state's `sensitive_attributes` are masked whatever their name. Extra checks: opened CIDRs, `publicly_accessible`, deletion protection off, skipped final snapshot, new access-control resources (IAM, security groups, policies).

**Kubernetes manifests.** Changes are keyed by `Kind/namespace/name`. Lists of named items (containers, env, ports, volumes) are keyed by name, so reordering is not drift. Fields the API server maintains (`resourceVersion`, `uid`, `managedFields`, `status`, the last-applied annotation) are dropped. `Secret` data is always masked. Extra checks: privileged containers, host network/PID/IPC, privilege escalation, running as root, a Service changed to `LoadBalancer`/`NodePort`, an image moved to `latest` or no tag. YAML is read by a small built-in parser for the subset manifests use; anchors, aliases, tags and merge keys are refused with an error rather than guessed.

**Baseline approval.** `tiresias_approve_baseline` records, after a person's yes, that specific drifted keys are accepted (with a reason) in `approved-drift.json`. Pass that file as `approved` and those changes are listed separately and not counted, until the value changes again; then the key alerts again and says so. Only a fingerprint of each value is stored (secrets get a slow, key-salted hash). Check a baseline file with `tiresias-of-drift validate-config approved_drift approved-drift.json`.

**Revert patch.** `tiresias_write_revert_patch` writes `revert.patch`, a unified diff that puts the later snapshot back to the earlier values (all drifted keys, or only `keys`), plus `revert-patch.json` with hashes and manual steps. It works for JSON config and `.env`/`.properties`. Secrets are never written into a patch, not even as context lines; they are listed as manual steps. For JSON that is not already 2-space formatted, the patch applies to the 2-space formatted form (`form: "normalized"`); the tool says which. The patch is checked to apply cleanly before it is written. Nothing is applied. For Terraform and Kubernetes the tool refuses and explains: change those through your code and change process.

**SARIF for CI.** `tiresias_write_report` also writes `drift.sarif` (SARIF 2.1.0) so drift can show up in code scanning. Messages carry keys and reasons, never values. The report's sha256 is returned as `output_sha256` and recorded in the audit line.

## Install

```bash
npm install -g tiresias-of-drift
tiresias-of-drift demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add tiresias-of-drift -- npx -y tiresias-of-drift@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "tiresias-of-drift": { "command": "npx", "args": ["-y", "tiresias-of-drift@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `tiresias_diff` | **allow** | Compare two snapshots |
| `tiresias_timeline` | **allow** | Drift across a folder of dated snapshots |
| `tiresias_write_report` | **allow** | Write `drift-report.md`, `drift.json`, `drift.sarif`, `revert-plan.json` to `mythos-out/tiresias` |
| `tiresias_write_revert_patch` | **allow** | Write `revert.patch` + `revert-patch.json` (JSON and `.env` snapshots). Applies nothing. |
| `tiresias_approve_baseline` | **ask (Auto-eligible)** | Record drift a person accepted in `approved-drift.json` |
| `tiresias_apply_fix` | **ask · one-click** | After a named human approves, record the fix in `apply-request-*.json` for your change process |
| `production_push_config` | **block** | Listed so agents see the refusal. Tiresias never writes to a live system. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

### MCP prompt

`drift_review` (arguments `before`, `after`, optional `approved`) walks a host model through diff → explain → approve expected drift → report and SARIF → revert patch, and stops at the human click for any production change.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `tiresias-of-drift approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`tiresias-of-drift kill`).

All analysis tools are read or report. `tiresias_approve_baseline` needs a person's yes (it can be opted in to Auto, which we do not recommend for high-risk keys). Applying a fix is `production_deploy`: it stays **one-click even in Auto**, and `--auto tiresias_apply_fix` is refused. Pushing config stays **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
tiresias-of-drift tools
tiresias-of-drift call tiresias_timeline '{"dir":"snapshots","ignore":["meta.generated_at"]}'
tiresias-of-drift eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not a configuration management, IaC or monitoring tool. It compares files you give it and changes nothing.
- Risk levels come from key names and values, not from knowledge of your system. A low-risk label is not a promise the change is safe.
- It does not fetch snapshots; export them on your own schedule. It does not call cloud APIs, `terraform` or `kubectl`, so it compares state to state, not state to live infrastructure.
- Terraform and Kubernetes checks are a short list of well-known risky settings, not a policy engine or a security scanner.
- Terraform state can hold secrets in plain text. Tiresias masks them in its output, but the state file itself is yours to protect.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/tiresias-of-drift>
