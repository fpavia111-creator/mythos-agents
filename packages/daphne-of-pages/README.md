# Daphne of Pages (`daphne-of-pages`)

> Audits a folder of exported HTML pages for broken links, basic SEO gaps and automatable WCAG checklist items, and writes a fix list. Publishing changes is one human click. A technical checklist, not a legal opinion.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

Point Daphne at a folder of HTML pages: a static build, or a saved copy of your site. It reads every `.html` file and reports, with the file and line:
- **links**: internal links, `#anchors` and images that point at nothing; `javascript:` and empty links. External links are listed, not fetched; Daphne makes no network calls;
- **SEO basics**: missing, short, long or duplicate titles and descriptions, no `<h1>` or several, `noindex`, no canonical link, no viewport;
- **sitemap and robots** (when `sitemap.xml` or `robots.txt` is in the site folder; read, never fetched): indexable pages missing from the sitemap, sitemap URLs with no page, sitemap URLs blocked by robots.txt, noindex or non-canonical pages listed in the sitemap, pages blocked by robots.txt without noindex, `Disallow: /` for every crawler, no `Sitemap:` line. robots.txt rules are read Google-style (longest match wins, `*` and `$` supported);
- **accessibility**: automatable checks mapped to WCAG 2.2 success criteria (a mapping, not a conformance result): images with no `alt` (1.1.1), form fields with no label (1.3.1, 4.1.2), links and buttons with no name (2.4.4, 4.1.2), vague link text, skipped heading levels, no page language (3.1.1), zoom blocked (1.4.4), untitled frames, positive `tabindex` (2.4.3), meta refresh (2.2.1), media that autoplays with sound (1.4.2), duplicate ids;
- **contrast from CSS** (1.4.3): text colour against background colour from `<style>` blocks, local stylesheets and inline styles, with the cascade (specificity, order, `!important`) and inheritance; 4.5:1, or 3:1 for large text (24px, or 18.66px bold; heading sizes use browser defaults). Text over images or gradients, CSS variables, semi-transparent layers and external stylesheets are **skipped and counted**, not guessed. Selectors with `+`/`~`, pseudo-classes and print rules are not used for colour;
- **focus**: rules that remove the focus outline with no replacement (2.4.7), focusable elements inside `aria-hidden="true"` (4.1.2), positive `tabindex` (2.4.3);
- **ARIA misuse**: unknown roles and `aria-*` attributes (typos such as `aria-lable`), invalid values (`aria-expanded="yes"`), `aria-labelledby`/`describedby`/`controls` pointing at missing ids, `role="button"` and other interactive roles that the keyboard cannot reach, `role="presentation"` on focusable elements, `role="img"` with no name, `aria-hidden` on `<body>`.

Every element-level issue carries a **CSS selector** (for example `body > main > a.btn-primary`), and every result has a **"do these first" list**: issues grouped by check and selector, scored by severity and reach, and marked "likely one template fix" when the same element fails on several pages.

It writes `page-audit.md`, a self-contained `page-audit.html` (no scripts) and `fix-list.csv` (selector column; blank owner and status columns). With approval it writes fixed **copies** and one **unified diff** (`fixes.diff`, applies with `patch -p1` or `git apply` inside the site folder) for mechanical fixes only: setting the page language you name, removing zoom blocks, adding a viewport, resetting positive `tabindex`. Alt text, titles, descriptions, labels and link text are left for a person; Daphne does not invent them.

## Install

```bash
npm install -g daphne-of-pages
daphne-of-pages demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add daphne-of-pages -- npx -y daphne-of-pages@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "daphne-of-pages": { "command": "npx", "args": ["-y", "daphne-of-pages@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `daphne_audit` | **allow** | Issues per page with severity, line, selector and WCAG mapping; sitemap/robots; prioritised actions; external links listed |
| `daphne_write_report` | **allow** | Write `page-audit.md`, `page-audit.html` and `fix-list.csv` to `mythos-out/daphne` |
| `daphne_draft_fixes` | **ask (Auto-eligible)** | Write fixed copies to `mythos-out/daphne/proposed`, `fixes.diff`, `changes.md` and `proposal.json` (your files untouched) |
| `daphne_request_publish` | **ask · one-click** | After a named human approves, record the proposal (bound to its hash) for whoever publishes |
| `deploy_site` | **block** | Listed so agents see the refusal. Daphne never deploys. |
| `http_fetch` | **block** | Listed so agents see the refusal. Daphne makes no network calls. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision.

### Config file and MCP prompt

`config` (optional) points at a JSON file checked against the `audit_config` schema: `base_url`, `ignore` (check ids), `ignore_pages` (paths, or folder prefixes ending in `/`), `contrast` (`normal` and `large` ratios), `sitemap` and `robots` file names, `template_min_pages`. Arguments override it; `ignore` lists are combined. Check a file with `daphne-of-pages validate-config audit_config daphne.config.json`.

The `daphne_site_review` prompt (arguments `site`, optional `base_url`, `lang`, `config`) walks a host model through audit → prioritised actions → report → diff of mechanical fixes → the one-click publish approval.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `daphne-of-pages approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`daphne-of-pages kill`).

`daphne_draft_fixes` can go on Auto. Publishing to a live site is a `production_deploy`: it stays **one-click even in Auto**, and `--auto daphne_request_publish` is refused. The approval is tied to the proposal's hash, and every proposed file and `fixes.diff` is re-hashed before it is recorded. Deploying and fetching stay **blocked**.

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
- Automated checks find only part of what WCAG covers, and the WCAG numbers are a mapping, not a conformance result. Contrast is computed from static CSS without layout: it does not see text over images, colours set by scripts, CSS variables, hover or focus states, or external stylesheets. Keyboard use, the real focus order, captions and screen-reader behaviour need a person and other tools.
- It reads static HTML. Content added by JavaScript after the page loads is not seen.
- Sitemap and robots checks read the files in the site folder; a sitemap index's child sitemaps are not followed, and pages are matched to sitemap URLs by path.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/daphne-of-pages>
