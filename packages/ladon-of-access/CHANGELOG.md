# Changelog

## 0.2.0 — 2026-11-16

Added (handoff ver 6)
- Recertification summary and evidence page in nine languages (`language` or `--lang`). recertification.csv, codes and the evidence JSON (and its hash) are the same in every language.
- Admin, owner and payment roles, disabled and deleted statuses, leavers and "no MFA" written in German, French, Spanish, Portuguese, Italian, Japanese, Chinese or Korean are recognised.

Fixed
- Privileged roles, SoD rules and learned roles written in Japanese, Chinese or Korean never matched (`\b` has no edge next to those characters).

- Memory (handoff ver 5): `ladon_recall`, `ladon_learn`, `ladon_accept_learning` and `ladon_retire_memory`, plus `ladon-of-access memory list|accept|reject|retire|verify`. Ladon can remember extra privileged roles, segregation-of-duties rules and standing reviewer delegations for one customer. A fact applies only after a named person accepts it (one click, never on Auto), and only adds to a check: learned roles are added to the built-in, policy or argument list, and policy-file rules and delegations win over learned ones. Results list the facts used under `memory`; lines privileged only by a learned role carry `privileged_by`, and the recertification summary has a "Learned facts used" section. `--no-memory` runs without it. Requires `mythos-agent-core` ^0.2.0 with domain memory.

- Real exports: Reads Okta, Microsoft Entra ID, Microsoft 365, Google Workspace, Slack, GitHub, AWS IAM credential report and Atlassian user exports, and a BambooHR roster, directly (see "Exports it reads"). When an export has no last-login column, `last_login` is left empty and the flag `last_login_not_in_export` (no score) replaces `never_logged_in`. Table inputs also accept TSV and Excel `.xlsx`; `inspect <file>` and `mythos-sources.json` help when columns differ.
### Added
- `ladon_campaign_status`: reads a filled recertification sheet and reports decided / open / overdue lines, incomplete sign-offs, self-reviews, lines signed by someone other than the assigned or delegated reviewer, a per-reviewer chase list and the lines marked revoke.
- `ladon_access_diff`: compares a previous and a current access export (added, removed, role changes, privilege gained, reactivated, deactivated, new agents/service accounts, owner changes) with a review-first list.
- `ladon_evidence_pack`: writes `recertification-evidence.json` and a self-contained HTML page with the sheet's sha256; the record hash is written to the audit line as `output_sha256`.
- Reviewer assignment, delegation and due dates in the sheet (`assigned_reviewer`, `delegated_to`, `due_date`; high-risk lines are due in half the time).
- Non-human identity checks: agents and service accounts without a credential rotation date, or rotated longer ago than `rotation_max_days` (only when the export has a rotation column).
- Segregation-of-duties rules (`sod_rules`) across systems.
- `ladon-policy` config schema (`configSchemas`), loaded with JSON-pointer errors; `validate-config ladon-policy <file>` works from the CLI.
- MCP prompt `ladon_recertification_campaign`.
- Plain-language `reasons` for every flag; `title` on every tool; stricter input schemas (`as_of` must be a date, day counts must be positive integers, unknown arguments are refused on the read/report tools).
- Fixtures: previous-quarter export, review policy, a filled sheet; the current export gained a `last_rotated` column and one NetSuite row (Casey Wong, A/P Clerk) to show a segregation-of-duties conflict.

### Changed
- `recertification.csv` has four more columns (`last_rotated`, `assigned_reviewer`, `delegated_to`, `due_date`). The reviewer columns are still blank.
- Eval `finds-leaver` now expects 10 accounts (was 9) because the fixture export gained one row.
- Column matching now keeps digits, so a `2FA` header is recognised.

### Not done
- Okta and Entra connectors (read-only) wait for the shared connector work (A3).
- Revocation is unchanged: it stays `revoke_access`, one named human click, even in Auto.

### Hardening (review pass)

- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

