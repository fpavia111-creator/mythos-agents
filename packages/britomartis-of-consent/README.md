# Britomartis of Consent (`britomartis-of-consent`)

> Inventories the cookies and third-party scripts a site actually sets and loads, compares them with your cookie policy and banner, and reports the gaps. Publishing changes is one human click. Not a consent-management platform, and it never claims GDPR or CCPA compliance.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Give Britomartis what the site really does: a folder of exported HTML pages and/or HAR captures from your browser's network panel. Use a clean profile and record a **first visit** before any choice, optionally a visit **after "Reject"**, and one **after "Accept"**. Add your stated policy as a small JSON file (cookies with provider, purpose and duration; third-party hosts with purpose). It builds an inventory and reports:
- **cookies**: every cookie set by a `Set-Cookie` header or by a script (seen in later requests), first or third party, lifetime, `Secure`, `SameSite`, and which capture it appeared in;
- **third-party hosts**: scripts, frames, pixels, fonts and requests to other sites, and whether a script in the HTML is consent-gated (`type="text/plain"` with a `data-category`, or similar);
- **gaps**: undeclared cookies and hosts; analytics or marketing cookies and requests **before consent** or **after a reject**; tracker scripts loaded with no gating; a page saying "no cookies", "no tracking cookies", "no trackers" or "no analytics" when the captures show otherwise; `SameSite=None` without `Secure`; cookies without `Secure` on https; lifetimes over about 13 months; durations that differ from the policy; declared items not seen; no consent banner or consent manager; no link to a cookie or privacy policy.

Purposes come from your policy. For anything undeclared, Britomartis uses a small built-in list of well-known vendors and **labels it a guess**. With approval it drafts a cookie table for your policy page, with `[TO CONFIRM]` wherever a person has to decide. It does not edit scripts, the banner or the policy text.

## Install

```bash
npm install -g britomartis-of-consent
britomartis-of-consent demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add britomartis-of-consent -- npx -y britomartis-of-consent@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "britomartis-of-consent": { "command": "npx", "args": ["-y", "britomartis-of-consent@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `britomartis_inventory` | **allow** | Cookie and third-party inventory with every gap against the declared policy |
| `britomartis_write_report` | **allow** | Write `consent-audit.md`, `cookie-inventory.csv` and `third-parties.csv` to `mythos-out/britomartis` |
| `britomartis_draft_policy_table` | **ask (Auto-eligible)** | Draft `cookie-table.md` and `declared.proposed.json` with `[TO CONFIRM]` markers, plus `proposal.json` with hashes |
| `britomartis_request_publish` | **ask · one-click** | After a named human approves, record the reviewed table (bound to its hash; refused while markers remain) for whoever publishes |
| `deploy_site` | **block** | Listed so agents see the refusal. Britomartis never changes the live site, banner or tag manager. |
| `http_fetch` | **block** | Listed so agents see the refusal. Britomartis makes no network calls. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `britomartis-of-consent approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`britomartis-of-consent kill`).

The inventory and report can run on a schedule over fresh captures, and `britomartis_draft_policy_table` can go on Auto. Publishing a policy, banner or site change is a `production_deploy`: it stays **one-click even in Auto**, and `--auto britomartis_request_publish` is refused. The approval is tied to the proposal's hash, every drafted file is re-hashed, and it is refused while any `[TO CONFIRM]` is left. To clear them, fill in `declared.proposed.json`, save it as your policy file and draft again. Deploying and fetching stay **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
britomartis-of-consent tools
britomartis-of-consent call britomartis_inventory '{"site":"site","base_url":"https://www.example.com","har_first_visit":"first-visit.har","declared":"declared.json"}'
britomartis-of-consent eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not legal advice, and it never says a site is GDPR, CCPA/CPRA or ePrivacy compliant. It is a technical inventory to check against what your policy and banner say.
- Not a consent-management platform. It shows no banner and stores no consent.
- It only sees what your files show. Cookies set on pages or flows you did not capture, or only for some visitors or regions, are missed. Vendor purposes for undeclared items are guesses.
- It does not crawl or fetch your site; you export the pages and record the captures.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. HAR files can contain cookie values and session tokens. Britomartis reports cookie names and attributes, never their values, but keep the captures private and delete them when you are done. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/britomartis-of-consent>
