# Changelog

## 0.2.0 (2026-11-15)

Changed (handoff ver 6)
- `slug` keeps letters of every script.

- Real exports: Reads BambooHR employee exports directly. Table inputs also accept TSV and Excel `.xlsx`; `inspect <file>` and `mythos-sources.json` help when columns differ.
- Per-role templates: a template `roles` section adds or removes tasks per role (optionally tied to a type). `unknown_role` when a role has no template (base checklist used); `access_outside_role` when access the role leaves out is marked granted.
- New `eos_offboarding`: offboarding mirror checklist from the end date (`remove-<task>` for granted access, `return-<task>` for equipment, plus `offboarding` tasks from the template) with `access_removal_overdue` and `equipment_not_returned` flags.
- New `eos_draft_offboarding` (ask, Auto-eligible): offboarding checklists and removal drafts dated for the end date. Recording a removal stays one-click (`eos_request_access_removal`, `revoke_access`).
- New `eos_owner_actions`: prioritised actions per owner across onboarding and offboarding, each with a reason.
- New `eos_readiness_report`: day-one readiness HTML and JSON; the JSON hash is recorded in the audit log as `output_sha256`.
- `eos_write_tracker` also writes `owner-actions.csv` and `onboarding-calendar.ics`.
- The template is validated against a JSON Schema (`validate-config template <file>`).
- New MCP prompt `run_onboarding`.
- Status rows for offboarding task ids (`remove-…`, `return-…`, template offboarding tasks) are no longer reported as unknown. Results for the 0.1.0 fixtures are otherwise unchanged.
- Not in this version: the read-only HRIS connector (needs the shared connector work).
- Unchanged: granting (`go_live`) and removing (`revoke_access`) access are one human click even in Auto; identity-provider writes and email stay blocked.

Hardening (review pass)

- Access-request and offboarding draft file names are built with `safeFileName` from the person and task ids.
- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

Speed (ver 4)

- Status rows are grouped by person once instead of being scanned for every person, and the offboarding drafts look people up by id. On 10,000 people, owner actions went from 35 s to about 1 s and the other reports from about 16 s to under 1 s; results are the same as before.
