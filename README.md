# Mythos Machine domain agents

Small MCP agents that each own **one business process** and cannot act outside it. Each one is its own npm package on a shared core. MIT, Node ≥ 20, local files only, no credentials.

| Package | Process | Install |
|---|---|---|
| [`mythos-agent-core`](packages/mythos-agent-core) | Manifest, allow/ask/block policy, Review/Assist/Auto modes, caps, kill switch, JSONL audit log, stdio MCP server, evals | `npm i mythos-agent-core` |
| [`olympus-of-migration`](packages/olympus-of-migration) | NetSuite/ERP migration export checks and a readiness report. Never approves go-live. | `npx -y olympus-of-migration demo` |
| [`epimetheus-of-scripts`](packages/epimetheus-of-scripts) | SuiteScript inventory and 2.1 risk ranking. Never deploys. | `npx -y epimetheus-of-scripts demo` |
| [`eirene-of-controls`](packages/eirene-of-controls) | Evidence folder from Talos / Mythos / Alethea logs. Evidence, not certification. | `npx -y eirene-of-controls demo` |
| [`ladon-of-access`](packages/ladon-of-access) | Access recertification for people, agents and service accounts. Never revokes by itself. | `npx -y ladon-of-access demo` |
| [`augeas-of-masters`](packages/augeas-of-masters) | Duplicate vendors/items and one approved merge at a time, on a copy. | `npx -y augeas-of-masters demo` |
| [`eucleia-of-outreach`](packages/eucleia-of-outreach) | Draft-only outreach gate: suppression, footer fields, Tue/Wed window, length limits. Never sends. | `npx -y eucleia-of-outreach demo` |
| [`nemesis-of-servers`](packages/nemesis-of-servers) | Static review of one MCP / Code Mode server or MCP config for risky patterns. Never runs it. | `npx -y nemesis-of-servers demo` |
| [`helios-of-seats`](packages/helios-of-seats) | Unused, idle, duplicate and over-tiered SaaS seats with estimated savings. Revoking is one click. | `npx -y helios-of-seats demo` |
| [`agon-of-evals`](packages/agon-of-evals) | Private evals for one process on one pinned model, with regression compare. Calls no model. | `npx -y agon-of-evals demo` |
| [`ananke-of-match`](packages/ananke-of-match) | AP three-way-match exceptions and a worklist. Never posts or pays. | `npx -y ananke-of-match demo` |
| [`penelope-of-recon`](packages/penelope-of-recon) | Bank-to-GL reconciliation: proposed matches, reconciling items, tie-out. Posting entries is one click. | `npx -y penelope-of-recon demo` |
| [`tiresias-of-drift`](packages/tiresias-of-drift) | Config and schema drift over time, explained with risk levels. Applying fixes to production is one click. | `npx -y tiresias-of-drift demo` |
| [`macaria-of-erasure`](packages/macaria-of-erasure) | Erasure request workflow: where personal data lives and a checklist. Deleting is one click; never deletes itself. | `npx -y macaria-of-erasure demo` |
| [`soteria-of-refunds`](packages/soteria-of-refunds) | Refund and chargeback triage against your policy. Never moves money. | `npx -y soteria-of-refunds demo` |
| [`nausicaa-of-hygiene`](packages/nausicaa-of-hygiene) | Contact-list hygiene: bounces, role addresses, duplicates, stale records, consent. Bulk deletes are one click. | `npx -y nausicaa-of-hygiene demo` |

## The rules every pack follows

- Unknown tools are blocked. The default decision is block.
- **Auto** is off by default and opt-in per action, with step/spend caps and a kill switch.
- Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a named person's click, even in Auto.
- Every decision goes to a hash-chained JSONL audit log.

## Develop

```bash
npm install      # links the workspaces
npm test         # node --test in every package
```

MIT © 2026 Kurt Francisco · <https://mythosmachines.com>
