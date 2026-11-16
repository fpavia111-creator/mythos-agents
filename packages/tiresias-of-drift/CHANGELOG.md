# Changelog

## 0.2.0 (2026-11-15)

- Terraform state snapshots (`.tfstate` / state JSON): drift keyed by resource address, added/removed resources as single items, `sensitive_attributes` masked, extra risk checks (public access, deletion protection, open CIDRs, new access-control resources).
- Kubernetes manifests (YAML or JSON, multi-document, `List`): drift keyed by `Kind/namespace/name`, named lists keyed by name, server-maintained fields dropped, `Secret` data masked, extra risk checks (privileged, host namespaces, root, exposed Service, mutable image tag). Plain YAML config files are read too. Built-in YAML subset parser, no dependencies.
- Baseline approval: new tool `tiresias_approve_baseline` (ask) writes `approved-drift.json` (config schema `approved_drift`); `approved` argument on diff, timeline, report and patch. Approved drift is not counted until its value changes again.
- Revert plan as a patch file: new tool `tiresias_write_revert_patch` writes `revert.patch` (unified diff, checked to apply cleanly) for JSON and `.env` snapshots. Secrets never appear in a patch.
- `tiresias_write_report` also writes `drift.sarif` (SARIF 2.1.0) and returns `output_sha256`, which goes into the audit line.
- Each change now carries `after_fp` (a value fingerprint) and, where it applies, `resource` and `secret`.
- MCP prompt `drift_review`; tool titles; stricter input schemas (non-empty paths, `keys` must be an array).
- Unchanged: applying a fix stays one-click (`production_deploy`) even in Auto; `production_push_config` stays blocked.

Hardening (review pass)

- Report hash is taken from the text as written.
- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

## 0.1.0

- First release: config and schema diff with risk levels, timeline, report, revert plan, one-click fix request.
