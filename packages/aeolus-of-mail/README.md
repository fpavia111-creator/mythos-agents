# Aeolus of Mail (`aeolus-of-mail`)

> Audits a sending domain's SPF, DKIM, DMARC and MX records with read-only DNS-over-HTTPS lookups, explains the gaps and pre-stages record changes. Changing DNS is one human click; Aeolus never edits DNS.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Aeolus a domain. It looks up the mail-authentication records through a public DNS-over-HTTPS resolver (Cloudflare by default, or Google), or reads a saved records file offline, and reports each gap with a severity, the record it is about, what it means and the RFC:
- **SPF**: missing or duplicate records, syntax, `+all` / `?all` / no `all`, `ptr`, and the **10-lookup limit counted through every include**, includes that point at nothing, void lookups and include loops. Pass `return_path` when your provider uses its own bounce subdomain, because SPF is checked there;
- **DMARC**: missing or duplicate records, syntax, `p=none` (monitoring only), partial `pct`, `sp=none`, no report address, and report addresses on another domain that has not authorised them. A subdomain with no record is shown inheriting the organisational domain's policy;
- **DKIM**: for the selectors you name (or a list of common ones), revoked keys, unreadable keys, keys under 1024 bits, 1024-bit keys, `t=y` testing. CNAME-delegated selectors are followed;
- **MX**: missing MX, null MX, MX hosts that are IP addresses or do not resolve; and, for domains that receive mail, MTA-STS and TLS-RPT records.

It writes `mail-dns-audit.md` and `findings.csv`. With approval it **pre-stages** record changes in `zone-change.md` and `proposed-records.json`: SPF from the senders you list, a merge of duplicate SPF records, a fixed `all` term, DMARC at `p=none` with reports, TLS-RPT. It never creates DKIM keys and never proposes an enforcing DMARC policy; those, and SPF over the lookup limit, are listed for a person.

## Install

```bash
npm install -g aeolus-of-mail
aeolus-of-mail demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add aeolus-of-mail -- npx -y aeolus-of-mail@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "aeolus-of-mail": { "command": "npx", "args": ["-y", "aeolus-of-mail@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `aeolus_audit` | **allow** | Look up and check the records; findings with severity, record, meaning and RFC |
| `aeolus_write_report` | **allow** | Write `mail-dns-audit.md` and `findings.csv` to `mythos-out/aeolus` |
| `aeolus_draft_records` | **ask (Auto-eligible)** | Pre-stage record changes in `zone-change.md` and `proposed-records.json` with its hash (DNS untouched) |
| `aeolus_request_dns_change` | **ask · one-click** | After a named human approves, record the change (bound to its hash) for whoever edits DNS; refused while `[TO CONFIRM]` markers remain |
| `dns_update` | **block** | Listed so agents see the refusal. Aeolus never edits DNS. |
| `send_test_email` | **block** | Listed so agents see the refusal. Aeolus never sends mail. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `aeolus-of-mail approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`aeolus-of-mail kill`).

`aeolus_audit` and `aeolus_write_report` can run on a schedule, and `aeolus_draft_records` can go on Auto. Changing DNS is a `production_deploy`: it stays **one-click even in Auto**, and `--auto aeolus_request_dns_change` is refused. The approval is tied to the proposal's hash and is refused while any `[TO CONFIRM]` or `[CHECK MERGE]` marker is left. Editing DNS and sending mail stay **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
aeolus-of-mail tools
aeolus-of-mail call aeolus_audit '{"domain":"example.com","selectors":["s1"],"return_path":"send.example.com"}'
aeolus-of-mail call aeolus_audit '{"domain":"example.com","records":"records.json"}'   # offline, from a saved file
aeolus-of-mail eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not a deliverability guarantee. DNS shows what is published, not how a message was actually signed or which servers really send for you; SPF/DKIM alignment and DMARC results need a real message header or DMARC reports.
- It cannot list DKIM selectors; it checks the ones you name and a list of common ones.
- The organisational domain is taken as the last two labels; check it yourself for suffixes like `.co.uk`.
- It never edits DNS at GoDaddy, Cloudflare or anywhere else, and never sends a test message.
- Not fully autonomous: anything risky waits for a named person.

## Data

Live audits send only domain names to the public resolver you choose (`cloudflare-dns.com` or `dns.google`) over HTTPS. Nothing else leaves your machine; no telemetry. With `records` the audit is fully offline. The bundled fixtures are fictional records for reserved example domains.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/aeolus-of-mail>
