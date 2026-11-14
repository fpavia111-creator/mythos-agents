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
