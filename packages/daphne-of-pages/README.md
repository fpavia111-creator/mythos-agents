# Daphne of Pages (`daphne-of-pages`)

> Audits a folder of exported HTML pages for broken links, basic SEO gaps and automatable WCAG checklist items, and writes a fix list. Publishing changes is one human click. A technical checklist, not a legal opinion.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Point Daphne at a folder of HTML pages: a static build, or a saved copy of your site. It reads every `.html` file and reports, with the file and line:
- **links**: internal links, `#anchors` and images that point at nothing; `javascript:` and empty links. External links are listed, not fetched; Daphne makes no network calls;
- **SEO basics**: missing, short, long or duplicate titles and descriptions, no `<h1>` or several, `noindex`, no canonical link, no viewport;
- **accessibility**: automatable checks mapped to WCAG 2.2 success criteria: images with no `alt` (1.1.1), form fields with no label (1.3.1, 4.1.2), links and buttons with no name (2.4.4, 4.1.2), vague link text, skipped heading levels, no page language (3.1.1), zoom blocked (1.4.4), untitled frames, positive `tabindex` (2.4.3), meta refresh (2.2.1), media that autoplays with sound (1.4.2), duplicate ids.

It writes `page-audit.md` and `fix-list.csv` (blank owner and status columns). With approval it writes fixed **copies** for mechanical fixes only: setting the page language you name, removing zoom blocks, adding a viewport, resetting positive `tabindex`. Alt text, titles, descriptions, labels and link text are left for a person; Daphne does not invent them.

## Install

```bash
npm install -g daphne-of-pages
daphne-of-pages demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add daphne-of-pages -- npx -y daphne-of-pages@0.1.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "daphne-of-pages": { "command": "npx", "args": ["-y", "daphne-of-pages@0.1.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `daphne_audit` | **allow** | Issues per page with severity, line and WCAG mapping; external links listed |
| `daphne_write_report` | **allow** | Write `page-audit.md` and `fix-list.csv` to `mythos-out/daphne` |
| `daphne_draft_fixes` | **ask (Auto-eligible)** | Write fixed copies to `mythos-out/daphne/proposed`, plus `changes.md` and `proposal.json` (your files untouched) |
| `daphne_request_publish` | **ask · one-click** | After a named human approves, record the proposal (bound to its hash) for whoever publishes |
| `deploy_site` | **block** | Listed so agents see the refusal. Daphne never deploys. |
| `http_fetch` | **block** | Listed so agents see the refusal. Daphne makes no network calls. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `daphne-of-pages approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`daphne-of-pages kill`).

`daphne_draft_fixes` can go on Auto. Publishing to a live site is a `production_deploy`: it stays **one-click even in Auto**, and `--auto daphne_request_publish` is refused. The approval is tied to the proposal's hash, and every proposed file is re-hashed before it is recorded. Deploying and fetching stay **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
daphne-of-pages tools
daphne-of-pages call daphne_audit '{"site":"site","base_url":"https://www.example.com","ignore":["canonical_missing"]}'
daphne-of-pages eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not a legal opinion, and it does not make a site ADA, WCAG or any other kind of compliant. It is a technical checklist for a first pass before a human accessibility review.
- Automated checks find only part of what WCAG covers. Colour contrast, keyboard use, focus order, captions and screen-reader behaviour need a person and other tools.
- It reads static HTML. Content added by JavaScript after the page loads is not seen.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/daphne-of-pages>
