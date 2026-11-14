# mythos-agent-core

The shared core for **Mythos Machine domain agents**: small MCP agents that each own one business process and cannot act outside it.

- **Pack manifest** — name, version, a declared model pin, the tool allowlist and the policy. `defineManifest()` fails closed: an unpinned model (`latest`), a tool without a rule, a write marked `allow`, or a one-click action marked `allow` are rejected at load time.
- **Talos-style policy** — every tool call gets `allow`, `ask` or `block`. Unknown tools are blocked. The default is block.
- **Modes**
  - **Review**: read and report tools only. Everything else is blocked.
  - **Assist** (default): the policy as written. `ask` returns an `approval_id` and waits for a named human.
  - **Auto**: off by default and **opt-in per action** (`--auto tool_a,tool_b`). Only opted-in `ask` actions run without a click. Step and spend caps and a kill switch always apply.
- **Always one-click, even in Auto**: `go_live`, `revoke_access`, `delete_personal_data`, `move_money`, `binding_send`, `production_deploy`. Trying to put one of these on Auto throws an error. Auto prepares the work; a person clicks.
- **Audit log** — append-only JSONL (`.mythos/audit.jsonl`), one line per decision, hash-chained so edits and removed lines show up. Arguments are stored as a SHA-256 hash, not in full. Field names follow Alethea's record vocabulary (`id`, `type`, `date`, `requirements`) so logs sit cleanly next to an Alethea `.decisions/` folder; this package does not write into `.decisions/`.
- **Stdio MCP server** — zero-dependency, newline-delimited JSON-RPC 2.0 (`initialize`, `ping`, `tools/list`, `tools/call`), plus a built-in `mythos_info` tool.
- **Private evals** — fixture-based, deterministic test cases (`expect.status`, `decision`, `contains`, `equals`).

MIT, Node ≥ 20, no runtime dependencies.

## Install

```bash
npm install mythos-agent-core
```

## A pack in 30 lines

```js
import { defineManifest, main } from 'mythos-agent-core';

const manifest = defineManifest({
  name: 'my-pack', version: '0.1.0', description: 'One process, nothing else.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5-20250929' },
  tools: [
    { name: 'my_check', kind: 'read', description: 'Read a CSV and report.',
      inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
      handler: async (args, ctx) => { const rows = ctx.records(args.path); return { summary: `${rows.length} rows`, rows: rows.length }; } },
    { name: 'my_fix', kind: 'write', description: 'Change something (needs a human).', handler: async () => ({ summary: 'done' }) },
    { name: 'my_go_live', kind: 'action', category: 'go_live', description: 'Never by an agent.' },
  ],
  policy: { rules: [
    { tool: 'my_check', decision: 'allow' },
    { tool: 'my_fix', decision: 'ask', reason: 'writes need a human' },
    { tool: 'my_go_live', decision: 'block' },
    { tool: '*', decision: 'block' },
  ] },
});

main(manifest); // gives you: mcp | tools | call | demo | eval | approve | kill | unkill
```

`ctx.records(path)` reads CSV, JSON or JSONL; `ctx.path()` refuses paths outside `--root`; `ctx.outDir()` creates an output folder inside it.

## Approvals

When a call is `ask`, the result contains an `approval_id` bound to that exact tool and arguments. A person approves it once:

```bash
npx -y -p mythos-agent-core mythos-approve 3f2a9c1d0b7e6a55 --as "Your Name" --dir .mythos
```

Then the same call runs and the log records who approved it.

**Honest limit:** approvals are a file. If the agent also has a shell in the same folder, it could write that file itself. For approvals to mean something, give the agent the MCP server only, not a shell, or keep `--state-dir` somewhere the agent cannot write.

## Kill switch and caps

- `npx <pack> kill` creates `.mythos/KILL`; every call is then blocked until `unkill`. `MYTHOS_KILL=1` does the same.
- `--max-steps N` and `--max-spend USD` stop a session and report. Spend counts each tool's declared `costUsd` (the wave-1 packs are local and declare $0), plus any `costUsd` a handler returns.

## Verify a log

```bash
npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl
```

The chain is tamper-evident, not tamper-proof: someone with write access can rewrite the whole file. Copy logs somewhere you control.

## What the model pin means

The manifest declares which host model a pack's prompts and evals target. An MCP server cannot force your MCP host to use that model; the pin is reported in `initialize` and `mythos_info` so you can check it. The wave-1 packs' tools are deterministic and call no model at all.

## Packs built on this core

`olympus-of-migration`, `epimetheus-of-scripts`, `eirene-of-controls`, `ladon-of-access`, `augeas-of-masters`. Source: <https://github.com/fpavia111-creator/mythos-agents>.

## License

MIT © 2026 Kurt Francisco
