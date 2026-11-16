import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

const w = (s) => process.stdout.write(s + '\n');

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)));
  w(`Agon of Evals demo (fictional AP-assistant suite) in ${rt.root}`);
  printStep('Validate the suite', await rt.call('agon_validate_suite', { suite: 'suite.json' }));
  printStep('Grade the baseline run', await rt.call('agon_grade', { suite: 'suite.json', responses: 'baseline.jsonl' }));
  const c = await rt.call('agon_grade', { suite: 'suite.json', responses: 'candidate.jsonl' });
  printStep('Grade the candidate run', c);
  for (const r of c.result.results.filter((x) => !x.pass)) w(`    FAIL ${r.id}${r.critical ? ' (critical)' : ''}: ${r.failures.join('; ')}`);
  printStep('Compare baseline vs candidate (one response per case)', await rt.call('agon_compare', { suite: 'suite.json', baseline: 'baseline.jsonl', candidate: 'candidate.jsonl' }));
  printStep('Grade a run from another model', await rt.call('agon_grade', { suite: 'suite.json', responses: 'other-model.jsonl' }));

  const t = await rt.call('agon_grade', { suite: 'suite.json', responses: 'trials-baseline.jsonl' });
  printStep('Grade a run with 5 trials per case', t);
  w(`    flaky: ${t.result.trials.flaky_cases.join(', ')} (pass threshold ${t.result.trials.pass_threshold})`);
  for (const cand of ['trials-candidate-noise.jsonl', 'trials-candidate-regressed.jsonl']) {
    const s = await rt.call('agon_compare', { suite: 'suite.json', baseline: 'trials-baseline.jsonl', candidate: cand, gate: 'gate.json' });
    printStep(`Is the change real? ${cand}`, s);
    for (const p of s.result.stats.per_case) w(`    ${p.id.padEnd(16)} ${p.baseline} -> ${p.candidate}  p=${p.p_value}  ${p.significant ? 'significant regression' : p.change < 0 ? 'within noise' : 'better'}`);
    w(`    gate: ${s.result.gate.result}${s.result.gate.reasons.length ? ' — ' + s.result.gate.reasons.join('; ') : ''}`);
  }
  const rb = await rt.call('agon_grade_rubric', { suite: 'suite.json', rubric: 'rubric.json', responses: 'baseline.jsonl', judgments: 'judgments.jsonl' });
  printStep('Grade against a rubric (every grade cites its criterion)', rb);
  for (const k of rb.result.results.flatMap((x) => x.criteria.map((y) => ({ id: x.id, ...y }))).slice(0, 5)) w(`    ${k.id.padEnd(15)} ${k.criterion} ${String(k.earned)}/${k.points}  ${k.evidence ? `"${k.evidence.quote}"` : k.reason}`);
  for (const k of rb.result.results.flatMap((x) => x.criteria.map((y) => ({ id: x.id, ...y }))).filter((y) => y.status === 'citation_not_found')) w(`    ${k.id.padEnd(15)} ${k.criterion} ${k.status}: ${k.reason}`);
  printStep('Grade tool use and structured output', await rt.call('agon_grade', { suite: 'suite-agent.json', responses: 'agent-run.jsonl' }));
  printStep('Write Markdown, JSON and JUnit', await rt.call('agon_write_report', { suite: 'suite.json', responses: 'trials-candidate-regressed.jsonl', baseline: 'trials-baseline.jsonl', gate: 'gate.json', rubric: 'rubric.json', judgments: 'judgments.jsonl' }));
  const d = await rt.call('agon_write_dashboard', { suite: 'suite.json', runs: ['trials-baseline.jsonl', 'trials-candidate-noise.jsonl', 'trials-candidate-regressed.jsonl'], labels: ['v1 baseline', 'v2 prompt tweak', 'v3 new tools'], gate: 'gate.json' });
  printStep('Write the offline HTML dashboard', d);
  w(`    open ${d.result.files[0]}`);
  printStep('Agent asks to publish the scores', await rt.call('agon_publish_results', {}));
  w(`\nAudit log: ${rt.stateDir}/audit.jsonl`);
}
