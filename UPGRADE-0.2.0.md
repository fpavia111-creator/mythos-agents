# Mythos agents 0.2.0: upgrade report

Date: 15 Nov 2026. Scope: `mythos-agent-core` and all 30 domain agents, 0.1.0 → 0.2.0. Nothing was published to npm, pushed to GitHub or deployed to the site.

## Verification

Run on Node 20.19.5, 22.23.4 and 24.11.0 in the build container (Linux). The Windows half of the matrix in `.github/workflows/test.yml` has not run; it runs when the repo is pushed.

- `npm test` across all 31 workspaces: **561 pass, 0 fail** on each of Node 20, 22 and 24 (was 249 in 0.1.0; 551 before the review pass).
- `eval` for all 30 agents: **420 of 420 cases pass** on each of Node 20, 22 and 24 (was 194).
- `npm run hostile` (new): 0 findings over 2,100 calls with 1,748 hostile values planted in the fixtures. `npm run hostile:args`: 0 findings over 20,610 calls (the same 2,100 plus 18,510 with broken arguments to all 240 tools).
- `demo` for all 30 agents exits 0.
- `npm pack --dry-run` for all 31 packages: no `node_modules`, `.mythos`, `mythos-out`, `.npmrc`, `.tgz` or test files.
- Policy check: every one of the 166 tools that existed in 0.1.0 has the same kind, category and allow/ask/block decision in 0.2.0. No write or action tool is `allow`. No one-click category is `allow`. 74 tools were added.
- Scans: no secrets (only the documented AWS example key in Nemesis fixtures), every "compliant / certified / fully autonomous / cleared for distribution" hit is a negation, fixture email domains are reserved example domains apart from two deliberate bad-address test cases in Nausicaa (`gmial.com`, `mailinator.com`).
- Echo of Docs run over every agent with its real tool list: 30 clean (the one false positive, on a config schema name, is fixed in Echo).
- Every HTML report opened in headless Chromium at desktop, phone (390 px) and dark settings: no network requests, no console errors, no sideways page scroll.

## Tools, tests and evals per agent

| Agent | Tools | Tests | Evals |
|---|---|---|---|
| aegle-of-certificates | 9 → 12 | 8 → 17 | 7 → 15 |
| aeolus-of-mail | 6 → 9 | 10 → 19 | 7 → 15 |
| agon-of-evals | 5 → 7 | 7 → 19 | 6 → 15 |
| ananke-of-match | 5 → 7 | 8 → 18 | 6 → 12 |
| arethusa-of-flows | 6 → 7 | 8 → 15 | 6 → 12 |
| augeas-of-masters | 4 → 6 | 7 → 18 | 7 → 14 |
| auxo-of-vendors | 6 → 8 | 8 → 16 | 6 → 12 |
| britomartis-of-consent | 6 → 7 | 9 → 18 | 7 → 13 |
| daphne-of-pages | 6 → 6 | 8 → 18 | 7 → 14 |
| echo-of-docs | 6 → 7 | 7 → 15 | 7 → 15 |
| eirene-of-controls | 4 → 7 | 7 → 20 | 5 → 14 |
| eos-of-onboarding | 8 → 12 | 7 → 15 | 6 → 13 |
| epeius-of-rfis | 6 → 10 | 7 → 14 | 6 → 14 |
| epimetheus-of-scripts | 4 → 7 | 7 → 19 | 6 → 14 |
| eucleia-of-outreach | 6 → 8 | 8 → 19 | 7 → 15 |
| helios-of-seats | 4 → 7 | 8 → 20 | 7 → 13 |
| hesperides-of-inventory | 5 → 7 | 8 → 15 | 6 → 12 |
| ladon-of-access | 3 → 6 | 7 → 16 | 6 → 13 |
| lycurgus-of-licenses | 6 → 8 | 8 → 21 | 8 → 17 |
| macaria-of-erasure | 6 → 9 | 7 → 14 | 7 → 13 |
| nausicaa-of-hygiene | 5 → 9 | 7 → 14 | 6 → 14 |
| nemesis-of-servers | 4 → 7 | 8 → 22 | 6 → 17 |
| olympus-of-migration | 4 → 6 | 8 → 19 | 7 → 14 |
| penelope-of-recon | 5 → 9 | 8 → 18 | 7 → 18 |
| polyhymnia-of-grants | 5 → 9 | 7 → 15 | 6 → 14 |
| praxidike-of-expenses | 6 → 10 | 8 → 17 | 7 → 14 |
| solon-of-clauses | 6 → 7 | 6 → 15 | 6 → 14 |
| soteria-of-refunds | 6 → 8 | 7 → 13 | 6 → 12 |
| tiresias-of-drift | 5 → 7 | 7 → 19 | 6 → 15 |
| urania-of-flux | 9 → 11 | 7 → 16 | 7 → 13 |
| **30 agents** | **166 → 240** | **227 → 514** | **194 → 420** |

Core tests went from 22 to 37.

## Core (`mythos-agent-core` 0.2.0)

Roadmap items A1, A2, A4, A5, A6, A8 and A10 are done. A3 (live connectors), A7 (shared fixture generator) and A9 (Pro licence hook) are not.

- **Input validation (A4, A10):** every call is checked against the tool's `inputSchema` before it runs or reaches a person; errors carry JSON-pointer paths. Manifests can declare `configSchemas`; `ctx.readJson(path, schema)` and `validate-config` use them.
- **Signed audit log (A2):** opt-in Ed25519 signature per line, `keygen`, signed `rotate-key`, `verify-log --pubkey`, optional mirror file. A re-chained log fails verification. Keys under `--root` are refused.
- **Approvals (A1):** local approvals page on 127.0.0.1 (strict CSP, no scripts, form token, Host and Origin checks), HMAC-signed outbound webhook and signed callback, reject, 24-hour expiry, a fresh cycle after use, non-human approver names refused.
- **Caps (A5):** persisted per session and per day, per-tool caps, structured cap result, `usage` command.
- **Hardening (A10):** `safePath` refuses symlink escapes and NUL bytes; CI matrix for Node 20/22/24 on Linux and Windows with eval and pack checks.
- **MCP:** protocol 2025-11-25, tool titles and annotations, prompts, pending approvals and usage in `mythos_info`.
- **Evals (A6):** offline HTML and JSON report, baseline comparison that fails on regressions, more expectation types.
- **Docs and scaffolder (A8):** `docs/build-an-agent.md`, `mythos-new-agent` scaffolder whose output passes tests untouched.
- **Shared helpers:** iCalendar, SARIF, unified diff and patch, HTML page, Jaro-Winkler and name/address normalisation, entropy, ZIP and DOCX reading.

## What each agent gained

Every agent also gained an MCP workflow prompt, a CHANGELOG and, where it reads a config file, a JSON Schema for it with typo tests. Reports that matter as evidence record their hash in the audit line.

- **Olympus of Migration:** tie-out by subsidiary and currency with user FX rates and tolerances; field rule checks with row numbers; trial-load to trial-load comparison; prioritised next actions; exceptions CSV; HTML report.
- **Epimetheus of Scripts:** a real tokenizer (comments and strings no longer counted), alias detection, per-file effort estimate with its breakdown, dependency graph with cycles and a stable conversion order, progress against an earlier inventory, SARIF.
- **Eirene of Controls:** verifies signed logs, maps evidence to your own control list with gaps and stale-evidence flags, period-to-period evidence diff, two starter templates, HTML index.
- **Ladon of Access:** reviewer delegation and due dates, campaign status with a chase list, non-human identity owners and rotation, segregation-of-duties rules, access diff between exports, evidence pack.
- **Augeas of Masters:** Jaro-Winkler matching weighted by word rarity, normalised tax ids and addresses, blocking for large files, field-level merge preview, byte-exact undo. Precision 0.986 and recall 1.0 on a seeded synthetic 1,000-row file.
- **Eucleia of Outreach:** configurable send windows, blackout dates and per-recipient time zones with DST tests, spam-phrase and link checks, unfilled-placeholder holds, Mailchimp/HubSpot/Resend suppression import, send schedule with caps.
- **Nemesis of Servers:** taint-style flows (secret to network, token passthrough, input to exec, path and URL), tool-description poisoning and shadowing checks, tool pinning for rug-pull detection, lockfile and advisory checks, OWASP MCP Top 10 and CWE mapping, SARIF with code flows, reviewer policy with justified suppressions.
- **Helios of Seats:** savings pro-rated to the next renewal you can still give notice for, renewal calendar, contract minimums, owner confirmation drafts, review-to-review comparison.
- **Agon of Evals:** rubric grading with cited criteria (it verifies recorded judgments, it calls no judge), bootstrap and exact-test regression statistics, repeated trials with flaky detection, CI gate files, tool-call checks, offline dashboard.
- **Ananke of Match:** partial receipts and several invoices per PO, per-vendor tolerances, received-not-invoiced view, near-duplicate invoice detection, vendor scorecard, HTML report.
- **Penelope of Recon:** CAMT.053, BAI2 and OFX parsers, match rules suggested from accepted matches and applied only after approval, month-end roll-forward with aging, one-to-many matching, sign-off page.
- **Tiresias of Drift:** Terraform state and Kubernetes manifests with secrets masked, approved-drift baseline, revert plan as a patch file, extra risk checks, SARIF.
- **Macaria of Erasure:** your own retention rules and legal holds with rule ids cited, matching on hashed identifiers, deadline tracker with calendar, per-request evidence pack.
- **Soteria of Refunds:** card-network reason-code mapping, per-category evidence checklists and HTML pack, prior undisputed order hints for fraud disputes, dispute deadline calendar.
- **Nausicaa of Hygiene:** merge plans with a winner per field and the rule that chose it, consent provenance check, export-to-export comparison, explained health score, opt-in MX check.
- **Aegle of Certificates:** opt-in live TLS expiry check, COI extraction from exported text (always marked for review), COI requirement profiles, inventory diff, validated calendar, HTML report.
- **Auxo of Vendors:** TIN rules per entity type (always masked), W-8 handling for foreign vendors, 1099 readiness summary, duplicate vendor detection including split payments.
- **Polyhymnia of Grants:** funder templates, budget-versus-actual variance with required explanations, spend-down projection, deadline calendar, zipped evidence pack with a hash manifest.
- **Urania of Flux:** percentage, ratio and direction claim checking against locked figures, SVG charts where every bar traces to a figure id, prior-pack comparison, self-contained HTML board pack.
- **Arethusa of Flows:** Power Automate and Workato exports, secret detection by known format and entropy (values never printed), cross-flow dependency map with a rotation plan, baseline, justified suppressions, SARIF.
- **Daphne of Pages:** contrast from static CSS, focus and ARIA checks with selectors, sitemap and robots consistency, fixes as an applicable diff, "do these first" list grouped by template, HTML report.
- **Praxidike of Expenses:** receipt text normalisation in five layouts, per-diem and mileage rules by date and location, duplicate receipts across reports, ranked audit queue with reasons, evidence pack.
- **Hesperides of Inventory:** lot and serial variance, unit-of-measure conversion with the arithmetic shown, ABC-ranked count plan with blind count sheets and calendar, accuracy by location, counter and class.
- **Eos of Onboarding:** per-role templates, offboarding mirror checklist with removal drafts, per-owner action list, day-one readiness report, calendar.
- **Epeius of RFIs:** drawing index from title-block text, ball-in-court aging with a chase list, transmittal drafts tied to the index, log-to-log diff, due-date calendar.
- **Britomartis of Consent:** vendor list grown from about 30 to about 135 hosts and versioned, Global Privacy Control check, scan-to-scan diff, HTML report, optional `britomartis-capture` helper that records the HARs with Playwright (not a dependency).
- **Lycurgus of Licenses:** pnpm, yarn, Poetry, uv, requirements.txt and Go lockfiles, licence text detection with confidence (low confidence always goes to review), NOTICE and attribution drafts, SBOM diff, metadata-versus-text mismatch flag.
- **Aeolus of Mail:** BIMI and ARC checks, DMARC aggregate report parser, staged none → quarantine → reject rollout plan with calendar, header analysis from a saved message, HTML report.
- **Echo of Docs:** GitHub Action and `ci` command with SARIF and baseline, OpenAPI drift, changelog-versus-version check.
- **Solon of Clauses:** DOCX input, defined-terms check, playbook version and hash cited in the memo, memo redline, draft-to-draft clause comparison.

## Review pass (15 Nov 2026)

A second pass over the finished upgrade, looking for what tests written alongside the code would miss. Method: plant hostile values in every agent's fixtures and run every eval case; call all 240 tools with one argument at a time replaced by junk; open every HTML report in a real browser.

Found and fixed:

| Finding | Where | Fix |
|---|---|---|
| 21 CSV files across 11 agents carried a cell a spreadsheet would run as a formula (a planted `=HYPERLINK(…)` in 20 of them) | core `toCsv` | Formula-like cells get a leading apostrophe; numbers, phone-style values and `@handles` are left alone |
| A planted `<script>` and `<img onerror>` came out raw in 29 Markdown files across 7 agents | core `ctx.writeFile` | Markdown output goes through `safeMarkdown` |
| An id of `../../../x` wrote files outside their output folder (inside `--root`) | Auxo, Polyhymnia | `ctx.writeFile` refuses such names; `safeFileName` used wherever a name comes from data (6 agents) |
| `eucleia_plan_schedule` never returned for a very large `min_gap_minutes` | Eucleia | Bounds on the three numbers and a gap search that jumps instead of stepping; same plans for valid input |
| "Cannot read properties of null" when a required path was an empty string | Agon, Macaria, Polyhymnia, Solon | Runtime refuses an empty required argument before the handler runs |
| `ENOENT: no such file or directory, open '/abs/path'` returned to the model | all | Plain sentence, root-relative path, absolute root removed, long messages clipped |
| A 200,000-character argument was echoed back whole in the error | all | Clipped at about 1,200 characters |
| A misspelled argument (`receipt` for `receipts`) was ignored and the tool ran without that input | the 208 tools without a strict schema | Refused with "did you mean"; unrelated extras now come back in `warnings` |
| Seven HTML reports pushed a phone-width page sideways; no header cell had a `scope`; numeric headers sat left of right-aligned numbers | core `htmlPage` | Tables wrapped, scopes added, headers aligned, inline SVG scales |
| Board pack chart said "vs bud" and a large number could run into the bars | Urania | "budget" in full; value column sized to its longest label |
| Echo reported a config schema name as a missing tool | Echo | Tool list file may carry `config_schemas` |

Added:

- **Instruction-like text in results is flagged.** A result that quotes "ignore previous instructions", fake chat markup, "do not tell the user" or hidden characters from the data carries a warning for the model and an `injection_signals` field in the audit line. On clean fixtures it fires only for Nemesis, whose fixtures hold poisoned tool descriptions on purpose. It is a heuristic and is described as one.
- **`scripts/hostile-inputs.mjs`**, `npm run hostile` and a CI step, so the check above runs on every change and on any agent made with the scaffolder.
- 10 new tests (8 in the core, 1 each in Eucleia and Echo).

Checked and found sound: nothing was read or written outside `--root` in 18,510 broken-argument calls; no planted HTML reached an `.html` or `.svg` output; no prototype pollution; policy decisions for every tool are unchanged.

Not changed, on purpose: the data in tool results is returned as it is in the files (the warning sits beside it), and no one-click category, cap or approval rule was touched.

## Real exports, licence keys and release check (15 Nov 2026, second pass)

Still 0.2.0 and still unpublished. Verified on Node 20.19.5, 22.23.4 and 24.11.0 (Linux): **666 tests pass, 0 fail** (561 before this pass) and **420 of 420 evals pass** on each. `npm run hostile:args`: 0 findings over 20,670 calls, now including every sample export with planted headers and cells and a broken Excel file. `npm run release:check` passes. No tool's kind, category or allow/ask/block decision changed.

**Real exports.** Twelve agents read 39 named exports directly, with no hand mapping: Ladon (Okta, Entra ID, Microsoft 365, Google Workspace, Slack, GitHub, AWS IAM credential report, Atlassian; BambooHR roster), Helios (Microsoft 365 active users, Google Workspace, GitHub Copilot, Atlassian), Auxo (NetSuite, QuickBooks Online including its grouped report, Xero), Ananke (NetSuite POs, receipts and bills; Xero bills), Soteria (Stripe, Shopify), Nausicaa (HubSpot, Salesforce report and Data Loader, Mailchimp), Eos (BambooHR), Epeius (Procore RFIs), Hesperides (NetSuite, Shopify inventory), Praxidike (Ramp, Expensify), Penelope (Chase checking and card, Bank of America, Wells Fargo, Capital One 360, Mercury, Xero statement; NetSuite, QuickBooks and Xero GL reports) and Aegle (AWS Certificate Manager, crt.sh). Every table input in every agent also takes TSV, semicolon/pipe text and Excel `.xlsx`. `inspect <file>` shows how a file is read (names and shapes, never values); `mythos-sources.json` fixes a mismatch without code. Each result says which export was recognised and what it lacks.
- How far to trust the layouts: Procore RFIs and Ramp transactions were compared with vendor documentation on 2026-11-15. The other 37 were written from knowledge of the exports and not checked; web pages for GitHub, Stripe, HubSpot and Expensify could not be read to confirm. **None was tested against a live account.** A real export that differs shows up as a "No column found" warning, not as wrong numbers.
- Behaviour changes: Ladon and Helios report "last login / last active not in export" instead of "never logged in" when an export has no such column; a file with none of an agent's required column now warns; dates written with dots are read day-first (with a warning when ambiguous); Praxidike gains `category_aliases` and refuses to stage reimbursements from a company card export; Penelope's `bank_format` gains `tsv` and `xlsx`.
- Agents that already read the real formats of their domain (Lycurgus, Arethusa, Nemesis, Daphne, Echo, Solon, Epimetheus, Eirene, Eucleia, Aeolus, Britomartis, Tiresias, Macaria, Olympus) and the four on their own layouts (Agon, Polyhymnia, Urania, Augeas) got no profiles.

**Licence keys (mechanism only).** Ed25519-signed offline keys, `tier: 'pro'` per tool, `needs_license` results, `license status|install|remove` in every agent and a seller tool `mythos-license keygen|issue|verify`. The trusted key list is empty and **no tool is marked paid**: both wait for your tier list and your own key pair, generated on your computer. The gate runs after the policy and cannot unblock, auto-approve or bypass a one-click category. It is not copy protection (MIT source).

**Release command.** `npm run release:check` checks npm names and versions (all 31 names are on npm under `kurtfrancisco` at 0.1.0, and 0.2.0 is higher), metadata and changelogs, git state, `.npmrc`, secrets in tracked and packed files, banned claims, one-click policy, tests, evals, the hostile run and pack contents, then prints the publish commands in order with a throwaway userconfig reading `NPM_TOKEN`. It never publishes. Writing it caught one bug in itself: Node 24 prints its test summary differently, which would have read as zero tests.

## Scale pass, handoff ver 4 (15 Nov 2026, third pass)

Still 0.2.0 and still unpublished; "ver 4" names the handoff bundle, not an npm version. New `npm run bench` runs every read and report tool that takes table files (68 tools in 21 agents) on generated 1,000- and 10,000-row fictional files, each in its own process with the policy on, and writes `mythos-out/bench/bench.md`. The generator is seeded: each copy of a fixture row gets its own ids, emails, party names, tax ids, phones and street numbers, amounts move by up to 10% and dates spread over four weeks.

The first run found nine agents that were quadratic or ran out of memory at 10,000 rows. All nine were rewritten to index or block instead of comparing everything with everything, and each rewrite was checked against the old code (same output on random and fixture data):

| Agent and tool | 10,000 rows before | after |
|---|---|---|
| Penelope reconcile / roll-forward / workpaper | 40 s / 35 s / 41 s | under 2 s each |
| Auxo duplicate vendors | over 3 minutes (est.; 7.3 s at 1,000) | about 11 s |
| Augeas duplicates and merge proposals | out of memory | under 3 s |
| Eos status, offboarding, owner actions, readiness | 16 to 35 s | about 1 s |
| Epeius RFI log review | timed out (180 s) | under 4 s |
| Eucleia draft check / send plan | 178 s / timed out | under 1 s / about 1 s |
| Polyhymnia review and template check | 31 s | under 1 s |
| Soteria evidence packs | 18 s | under 5 s |
| Praxidike duplicates, audit queue, evidence pack | timed out / out of memory | about 2 s |

Final run (Node 22, 4-core Linux container): 66 of 68 tools ran at 10,000 rows (Urania's charts and pack need figures locked first, so they were skipped); 49 finished under 1 s, 61 under 3 s, the slowest was Auxo's duplicate vendor check at about 11 s, peak memory 245 MB. Auxo's check compares names pairwise by nature; it now scores only pairs that can reach the threshold.

Two outputs change on very large or odd files: Augeas lists a tax id or phone shared by more than 500 rows under `not_compared` instead of pairing them all, and Praxidike lists a receipt shared by more than 200 lines under `not_paired`. Epeius names at most five similar earlier RFIs per RFI and counts the rest. Full table: `docs/bench-2026-11-15.md`. Tests: 670 pass on Node 20, 22 and 24; evals 420 of 420; `npm run hostile:args` 0 findings over 20,670 calls (it caught one hang in the new Penelope code, a huge `date_window` walking every day in the range, now fixed and tested); `npm run release:check` passes.

## Domain memory, handoff ver 5 (16 Nov 2026)

Still 0.2.0 and unpublished. Olympus and Ladon can now remember facts about one customer's setup, built from the idea in Grok's `mythos-domain-memory` package (its code was not used; the handoff's `REVIEW-ver5.md` says why).

- Core: `DomainMemory` and `memoryTools(prefix, kinds)` give an agent `<prefix>_recall` (read), `<prefix>_learn` (report: stores a waiting fact that changes nothing), and `<prefix>_accept_learning` / `<prefix>_retire_memory` in the new one-click category `accept_learning` (always a named person, never on Auto). One hash-chained file per agent under `.mythos/memory/`, signed with the audit key when one is set. Each acceptance must match an approval by the same person for exactly that fact; otherwise it is `unverified` and unused. Credentials, personal identifiers and instruction-like text are refused. Results carry `memory_applied`; audit lines carry the fact ids. The person approving sees the fact itself, not just its id (in the result, on the approvals page and in `approvals list`). CLI: `<agent> memory list|accept|reject|retire|verify` and `--no-memory`.
- Olympus learns column names (used only when the call and config leave a setting unset) and extra field rules. Ladon learns extra privileged roles, segregation-of-duties rules and standing reviewer delegations. Every kind adds to a check; tolerances, FX rates, stale days and rotation limits cannot be learned, and config or policy entries win over learned ones. Reports list the facts used.
- Tests: 704 pass on Node 20, 22 and 24 (34 new); evals 434 of 434 (14 new); `npm run hostile:args` 0 findings over 21,138 calls, including the eight memory tools. A Ladon memory file with 2,500 accepted facts loads and verifies in about 0.1 s, and a 10,000-row review using all of them runs in about 0.4 s.

## Other markets and languages, handoff ver 6 (16 Nov 2026)

Still 0.2.0 and unpublished. The question was whether the agents work for the largest software markets in their own languages, and what else they miss there.

**Which markets.** By 2024 software spending (S&P Global via WIPO): United States 368.5, China 61.8, Germany 22.2, United Kingdom 20.3 and France 19.3 billion USD, of a world total of 675. By 2025 software plus IT services (IDC, quoted by ABES): US 1,082; UK 121; Germany 113; China 113; Japan 91; France 79; Canada 57; Australia 43; Italy 39; India 35; Brazil 35; Netherlands 35; Spain 29; Switzerland 28; Sweden 20; Korea 19; Mexico 19 billion USD. Grouped by the language people work in, the top seven are English, German, Chinese (Simplified), Japanese, French, Spanish and Portuguese (Brazil). Italian and Korean were added as blind spots: sizeable markets where English-only tools are a poor fit and the file formats differ (`₩`, `2026. 11. 14.`). Dutch buyers mostly work in English; Arabic is not in IDC's top 17. Sources: [WIPO, global software spending](https://www.wipo.int/en/web/global-innovation-index/w/blogs/2025/global-software-spending); [ABES study with IDC figures (PDF)](https://set.org.br/wp-content/uploads/2026/04/ABES-Estudo-Mercado-Brasileiro-de-Software-2026-Previsoes_v2-4.pdf); [ABES ranking](https://abes.org.br/en/software-brasileiro-cresceu-185-ano-passado-e-mantem-a-10a-posicao-no-ranking-mundial/); [ITPro on European software spending](https://www.itpro.com/software/european-software-spending-is-set-to-surge-in-2026-heres-why).

**Blind spots found and fixed.**

| What went wrong | Where | Now |
|---|---|---|
| Japanese, Chinese and Korean files in their usual encodings (Shift_JIS, GB18030, Big5, EUC-KR) and UTF-16 exports read as gibberish | core | Decoded; a guessed encoding is named in the warnings; `encoding` can be set per file |
| `12,5` read as 125 and `1.234,56` as 1.23456 | core `toNumber`, Olympus | Read as 12.5 and 1234.56; one decimal mark per column |
| `R$`, `円`, `￥`, `₩`, `△300`, Indian grouping not read | core | Read |
| Dates such as `14. November 2026`, `2026年11月14日`, `令和8年`, `2026년 11월 14일`, `14/NOV/2026` not read | core, Praxidike | Read, with month names in seven European languages |
| Column names matched in English only; CJK headers all became "" and collided | core, all agents that read tables | About 100 columns known in eight more languages; headers in any script compare |
| Names in Japanese, Chinese or Korean normalized to nothing, so their duplicates were never found | core, Augeas, Ananke, Auxo | Every script kept; legal forms such as 株式会社, (株), 有限公司, 주식회사, GmbH, SARL, S.L., S.A. de C.V., Ltda., S.r.l. ignored |
| Mexico's generic RFCs (XAXX010101000, XEXX010101000) made unrelated vendors one merge proposal | Augeas | Never used to pair; counted under `not_compared` |
| Chinese credit codes lost their final letter, so two companies could be joined | Augeas | Kept |
| Privileged roles, SoD rules and leaver words in CJK never matched (`\b` does not match next to CJK) | Ladon | Matched; status words (退職, ausgeschieden, 퇴사...) read |
| Receipts in other languages: totals, tax, dates and currencies missed; yen and won read with decimals | Praxidike | Read; `Sous-total` is no longer a total |
| No MT940 bank statements, the common format in Germany | Penelope | Read, including German structured `:86:` fields |
| Refund disputes written in other languages were always "general"; JCB and UnionPay unknown | Soteria | Classified from the text in eight more languages; JCB and UnionPay recognised by name |
| Consent, status and bounce values in other languages read as unknown, so a withdrawn consent was not suppressed | Nausicaa | Read; role mailboxes such as `kontakt@` and `ventas@` flagged |
| Yes/no columns read English only | core | Nine languages and form marks (○, ×) |
| File names from Japanese, Chinese or Korean ids became empty or collided | core, Aegle, Arethusa, Auxo, Eos, Helios | Kept, with numbered duplicates |
| RFI titles in CJK never matched as similar | Epeius | Character pairs compared |
| Merge previews showed no conflict between two different CJK addresses | Augeas | Shown |

**Pages people read, in their language.** `--lang de|fr|es|pt|it|ja|zh|ko` (or `MYTHOS_LANG`) writes the approvals page, the Olympus readiness report and the Ladon recertification summary and evidence page in that language. Results, codes, JSON and CSV stay in English so scripts and audits read the same everywhere; the evidence record and its hash do not change with the language. The root README is in all nine languages.

**Verification.** Tests: **746 pass, 0 fail** on each of Node 20.19.5, 22.23.4 and 24.11.0 (704 in ver 5). Evals: **441 of 441** on each (434 in ver 5; new cases read a Shift_JIS trial balance, a Shift_JIS access export with its roster, a Japanese and a Mexican vendor master, a German MT940 statement, and dispute reasons in Japanese and German). `npm run hostile:args`: 0 findings over 21,218 calls with 3,161 planted values. `npm run release:check:offline`: every step passes; the npm name check needs the network and was skipped. The Node 20 run caught one real bug, now fixed: Node 20 decodes Windows-1252 bytes 0x80-0x9F as control characters, so German and French files lost their euro signs.

**Honest limits.** Every translation was written by Claude and has not been reviewed by a native speaker. The word lists (dispute reasons, consent values, status words, receipt labels) are short and will miss phrasings; a value that is not recognised is left as unknown, never guessed. Nothing in this pass makes any claim about a country's laws, tax rules, consent rules or filing formats.

## Not done

- **Windows** has not run the suite (the CI matrix covers it once the repo is on GitHub).
- **Not covered from the market work (ver 6):** Japanese Zengin fixed-width bank files; scanned receipts (there is no OCR, only receipt text); Eucleia's footer and send-window checks follow English-language outreach habits; JCB and UnionPay reason codes; two-digit-year dates such as `26/11/14`, which are read day-first, so a Japanese or Korean year-first short date is misread; reports other than the approvals page, Olympus and Ladon are in English.
- **The injection check is a short pattern list.** It will miss paraphrased or non-English attempts. Its phrases are English. The protection that does not depend on it is that go-live, money, access, deletion, binding sends and deploys need a named person.

- **Live connectors (A3):** agents read exported files, not live APIs. The export profiles cover the same systems offline; none was tested against a real account.
- **Real customer volumes:** the scale test uses generated fictional rows; real exports can be messier (very long text, many columns).
- **Paid tier:** the licence mechanism is built; which tools are paid, and the trusted key, wait for you.
- **Competitor research was shallow:** searches returned result titles, not page contents, so feature choices rest on general knowledge of the named products rather than on pages read during this work.
- **The website** (cards, JSON-LD) was not touched; it is not in this repo.

## Decisions for the owner

1. **Auxo demo shows no "ready" vendor.** The new TIN rules correctly flag the fictional placeholder TINs. Either accept it or allow a small set of documented placeholder TINs to pass in fixtures.
2. **Aeolus does live DNS lookups by default** when no records file is given, including in review mode. This is unchanged from 0.1.0 but sits awkwardly with "network is opt-in". Recommend making it opt-in in 0.2.1.
3. **Nemesis ships a small advisory snapshot naming real public CVEs.** Someone must own refreshing it, or drop it.
4. **Stricter inputs are a behaviour change.** Configs reject unknown keys. For tool arguments the rule is now the same everywhere: a near miss of a real argument name is refused with the right name; an unrelated extra is refused by the tools that declare `additionalProperties: false` (32 of 240) and ignored with a warning by the rest. Say if you want all 240 strict.
5. **Default changes:** Augeas threshold is 0.92 on a new score (was 0.88 on a different one); Eirene with `public_keys` requires every log in the call to be signed; several CSV outputs gained columns (listed in each CHANGELOG under changed behaviour).
6. **Approvals that can go on Auto:** `tiresias_approve_baseline` and `penelope_accept_rule` are plain `ask`. Say if they should never be Auto.
7. **`britomartis-capture`** makes real requests unless run with `--offline`. Confirm it should ship.
8. **Lycurgus fixture** includes the full Apache-2.0 text; Echo's Action example points at `@main` and needs 0.2.0 published to work.

## Before release

Run `npm run release:check` and the CI matrix (Linux and Windows), then publish core first and agents after (they depend on `mythos-agent-core ^0.2.0`). Update the site cards after publish.
