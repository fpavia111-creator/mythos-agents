import { fileURLToPath } from 'node:url';
import { demoRuntime, printStep } from 'mythos-agent-core';

export async function demo(manifest) {
  const rt = demoRuntime(manifest, fileURLToPath(new URL('../fixtures', import.meta.url)));
  process.stdout.write(`Agon of Evals demo (fictional AP-assistant suite) in ${rt.root}\n`);
  printStep('Validate the suite', await rt.call('agon_validate_suite', { suite: 'suite.json' }));
  printStep('Grade the baseline run', await rt.call('agon_grade', { suite: 'suite.json', responses: 'baseline.jsonl' }));
  const c = await rt.call('agon_grade', { suite: 'suite.json', responses: 'candidate.jsonl' });
  printStep('Grade the candidate run', c);
  for (const r of c.result.results.filter((x) => !x.pass)) process.stdout.write(`    FAIL ${r.id}: ${r.failures.join('; ')}\n`);
  printStep('Compare baseline vs candidate', await rt.call('agon_compare', { suite: 'suite.json', baseline: 'baseline.jsonl', candidate: 'candidate.jsonl' }));
  printStep('Grade a run from another model', await rt.call('agon_grade', { suite: 'suite.json', responses: 'other-model.jsonl' }));
  printStep('Write Markdown, JSON and JUnit', await rt.call('agon_write_report', { suite: 'suite.json', responses: 'candidate.jsonl', baseline: 'baseline.jsonl' }));
  printStep('Agent asks to publish the scores', await rt.call('agon_publish_results', {}));
  process.stdout.write(`\nAudit log: ${rt.stateDir}/audit.jsonl\n`);
}
