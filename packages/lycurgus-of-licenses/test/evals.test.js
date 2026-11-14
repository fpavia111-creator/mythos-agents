import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runEvalFile } from 'mythos-agent-core';
import { manifest } from '../src/index.js';

test('private evals all pass', async () => {
  const r = await runEvalFile(manifest, fileURLToPath(new URL('../evals/cases.json', import.meta.url)));
  for (const c of r.results) assert.ok(c.pass, `${c.id}: ${c.fails.join('; ')}`);
  assert.ok(r.total >= 5);
});
