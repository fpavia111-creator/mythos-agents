Fictional AP-assistant eval suites and recorded responses. No model was called to make them; they are hand-written examples.

- `suite.json`: six cases with tags, one critical case and `pass_threshold` 0.8.
- `baseline.jsonl`, `candidate.jsonl`, `other-model.jsonl`: one response per case (the candidate regresses the critical case; the other-model run is not comparable).
- `trials-baseline.jsonl`, `trials-candidate-noise.jsonl`, `trials-candidate-regressed.jsonl`: five trials per case. The noise run differs from the baseline by single flipped trials; the regressed run fails the critical case in every trial.
- `rubric.json`, `judgments.jsonl`: a rubric with check-based and judged criteria, and three recorded judgments (one verified, one quoting text that is not in the output, one citing a criterion that does not exist).
- `gate.json`: a gate that fails on a significant regression.
- `suite-agent.json`, `agent-run.jsonl`: cases for the `json_schema`, `tool_order`, `tool_args` and `max_tool_calls` checks.
