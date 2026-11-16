# Agon of Evals (`agon-of-evals`)

> Private, fixture-based evals for one business process on one pinned model. Grades recorded responses, tells real regressions from noise, and writes an offline dashboard; calls no model; publishes nothing.

Part of [Mythos Machine](https://mythosmachines.com) domain agents: one agent, one process, nothing outside its lane. Built on [`mythos-agent-core`](https://www.npmjs.com/package/mythos-agent-core). MIT, Node ≥ 20, runs on your machine, no account or API key needed.

## What it does

You write a suite (`suite.json`: the process, the pinned model id, and cases with checks) and record your agent's responses (JSONL: `case_id, output, tool_calls, model`). Agon grades them deterministically. Checks:
- `contains`, `not_contains`, `regex`, `not_regex`, `equals`;
- `max_words`, `min_words`;
- `refusal` / `no_refusal`;
- `required_tools`, `forbidden_tools` (for example "never call `update_vendor_bank`");
- `number` with a tolerance (`$1,250.00` reads as 1250);
- `json_schema` (the output, or its fenced `json` block, must match a JSON Schema; failures name the JSON pointer);
- `tool_order` (tools called in this order), `tool_args` (a call carried these argument values), `max_tool_calls`.

Cases can carry `tags` (results are also reported per tag), `critical: true` (a gate always requires them to pass) and a `weight`.

The suite must pin an exact model id (no `latest`). Responses with no model id, or from a different model, are graded but marked **not comparable**. `agon_compare` lists regressions and fixes between a baseline and a candidate run. Reports come as Markdown, JSON and JUnit XML for CI.

**Repeated trials.** Record the same case several times (several rows with the same `case_id`) and Agon reports a pass rate per case, which cases are flaky, and passes a case when its rate reaches the suite's `pass_threshold` (default 1: every trial).

**Is the change real?** `agon_compare` adds `stats`: a bootstrap confidence interval on the score change, with a verdict of `regression`, `improvement` or `within_noise`. It is seeded (default seed 1, 2000 resamples), so the same files give the same interval. With trials it resamples trials inside each case and runs a one-sided Fisher exact test per case, naming the cases that regressed significantly and the ones that only wobbled. With one response per case it resamples cases and adds an exact sign test; with a small suite that interval is wide, and the result says so. `min_delta` ignores drops smaller than a number of points you choose.

**Rubric grading with cited criteria.** `agon_grade_rubric` scores each response against a rubric (`criteria` with `id`, `text`, `points`). A criterion is graded either by checks (Agon quotes the text that met it) or by a judgment you recorded elsewhere, from a person or your own judge model. Agon calls no judge. It verifies recorded judgments instead: each must cite a criterion that exists and quote text that really is in the recorded output; a quote that is not there earns nothing (`citation_not_found`), and criteria without a judgment are `pending` and left out of the score. Every grade carries the criterion id, its text and the evidence or reason.

**Gate.** A gate file sets `min_score`, `max_regressions` or `fail_on: "significant_regression"`, `must_pass`, `max_flaky`, `min_rubric_score` and whether the run must be comparable. Tools that take `gate` return `gate: { result: pass|fail, reasons }`.

**Offline dashboard.** `agon_write_dashboard` writes one self-contained `dashboard.html` for a series of runs: score trend, a case-by-run grid with regressions and fixes highlighted, flaky and critical cases, per-tag results and the statistics for the last two runs. Inline CSS only: no scripts, fonts, images or links, and a `default-src 'none'` content security policy, so opening it makes no network requests. No timestamps, so the same runs give the same bytes.

## Install

```bash
npm install -g agon-of-evals
agon-of-evals demo        # runs on the bundled fictional sample data
```

### As an MCP server

**Claude Code**

```bash
claude mcp add agon-of-evals -- npx -y agon-of-evals@0.2.0 mcp --root /path/to/your/exports
```

**Cursor / Claude Desktop / VS Code / Windsurf**

```json
{ "mcpServers": { "agon-of-evals": { "command": "npx", "args": ["-y", "agon-of-evals@0.2.0", "mcp", "--root", "/path/to/your/exports"] } } }
```

`--root` is the only folder the tools can read or write. Paths outside it are refused.

## Tools

| Tool | Policy | What it does |
|---|---|---|
| `agon_validate_suite` | **allow** | Check the suite: schema (JSON-pointer errors), pinned model, ids, checks, regexes |
| `agon_grade` | **allow** | Grade one recorded run (trials, tags, critical cases, optional gate) |
| `agon_compare` | **allow** | Baseline vs candidate: regressions, fixes, delta, and a bootstrap interval with a noise/regression verdict |
| `agon_grade_rubric` | **allow** | Grade against a rubric; every grade cites its criterion and evidence |
| `agon_write_report` | **allow** | Write `eval-report.md`, `eval-results.json`, `junit.xml` to `mythos-out/agon` (optional baseline, rubric, gate) |
| `agon_write_dashboard` | **allow** | Write the offline `dashboard.html` and `dashboard.json` for a series of runs |
| `agon_publish_results` | **block** | Listed so agents see the refusal. Results stay private. |

Any other tool name is blocked. `mythos_info` shows the pinned model, mode, caps and every decision. Report tools record the hash of what they wrote in the audit log (`output_sha256`).

### Prompt

`agon_eval_run` (MCP prompt) walks a host model through a run: validate the suite, grade, compare with a baseline, grade the rubric, write the report and dashboard, then leave the ship decision to a person. Arguments: `suite` and `candidate` (required), `baseline`, `gate`.

## Config files

Suites, rubrics and gates are checked against JSON Schemas before use. A typo fails with a JSON-pointer path (for example `/cases/0/checks/contain is not an allowed property`). Unknown keys are refused, so use `notes` on a case for free text.

```bash
agon-of-evals validate-config agon-suite suite.json
agon-of-evals validate-config agon-rubric rubric.json
agon-of-evals validate-config agon-gate gate.json
```

```json
{ "min_score": 80, "fail_on": "significant_regression", "min_delta": 2, "confidence": 0.95, "resamples": 2000, "seed": 7, "max_flaky": 2 }
```

```json
{ "rubric": "answer-quality-v1", "pass_score": 70, "criteria": [
  { "id": "R1", "text": "States the amount with a currency symbol", "points": 2, "applies_to": ["invoice-total"], "checks": { "regex": ["\\$\\d"] } },
  { "id": "R5", "text": "Tone is plain and professional", "points": 2, "judged": true }
] }
```

Judgments (JSONL/CSV/JSON) for judged criteria: `case_id, criterion, score` (0 to 1), `quote` (copied from the output), and optional `rationale`, `judge`.

## Modes

- **Review** (`--mode review`): read and report only.
- **Assist** (default): the policy above. `ask` returns an `approval_id`; a person approves once with `agon-of-evals approve <id> --as "Your Name"`.
- **Auto** (`--mode auto --auto <tool,...>`): off by default, opt-in per action, with step/spend caps (`--max-steps`, `--max-spend`) and a kill switch (`agon-of-evals kill`).

All tools are read or report, so Auto changes nothing here. Publishing scores is `binding_send` and stays **blocked**.

Go-live, revoking access, deleting personal data, moving money, legally binding sends and production deploys always need a person's click, in every Mythos pack.

## CLI

```bash
agon-of-evals tools
agon-of-evals call agon_compare '{"suite":"suite.json","baseline":"baseline.jsonl","candidate":"candidate.jsonl"}'
agon-of-evals call agon_compare '{"suite":"suite.json","baseline":"baseline.jsonl","candidate":"candidate.jsonl","gate":"gate.json","seed":7}'
agon-of-evals call agon_write_dashboard '{"suite":"suite.json","runs":["run-1.jsonl","run-2.jsonl","run-3.jsonl"]}'
agon-of-evals eval          # private evals on the bundled fixtures
```

Every call is written to `.mythos/audit.jsonl` (hash-chained JSONL; arguments stored as a hash). Read it with [`eirene-of-controls`](https://www.npmjs.com/package/eirene-of-controls) or `npx -y -p mythos-agent-core mythos-verify-log .mythos/audit.jsonl`.

## What it is not

- Not a benchmark or leaderboard, and a score is not a certification. It covers your suite and your pinned model only.
- It does not run your agent or call any model. You record the responses; Agon grades them.
- Rule-based checks cannot judge open-ended quality. Use them for things that must or must not happen. For judged rubric criteria Agon checks the citation, not the judgment: a verified quote shows the judge pointed at real text, not that the score is right.
- The statistics describe the recorded runs. An interval from one response per case on a small suite is wide; `within_noise` means the data cannot tell, not that nothing changed. Critical cases belong in the gate (`critical: true` or `must_pass`), not in a significance test.
- With trials, the rubric grades the first recorded response of each case.
- The dashboard is a static page. It has no filters or drill-down, and it shows only the runs you pass in.
- Not fully autonomous: anything risky waits for a named person.

## Data

Everything runs locally on files you choose. No network calls, no telemetry. The bundled fixtures are fictional.

## License

MIT © 2026 Kurt Francisco. Source: <https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/agon-of-evals>
