// Rubric grading with cited criteria. Deterministic, calls no model.
// A criterion is either:
//  - automatic: it has "checks" (the same check kinds as suite cases); Agon cites the text that met it;
//  - judged: a person or your own judge model scored it elsewhere and you pass the judgments file.
//    Agon then verifies each judgment: it must cite a criterion that exists, and its quote must
//    appear in the recorded output. A judgment whose quote is not in the output earns nothing.
import { round2 } from 'mythos-agent-core';
import { runChecks, CHECKS } from './grade.js';

const strOrList = { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] };
export const CHECKS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    contains: strOrList, not_contains: strOrList, regex: strOrList, not_regex: strOrList,
    equals: { type: ['string', 'number', 'boolean'] },
    max_words: { type: 'integer', minimum: 0 }, min_words: { type: 'integer', minimum: 0 },
    refusal: { type: 'boolean' }, no_refusal: { type: 'boolean' },
    forbidden_tools: strOrList, required_tools: strOrList,
    number: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'number' }, tolerance: { type: 'number', minimum: 0 }, pattern: { type: 'string' } } },
    json_schema: { type: 'object', description: 'JSON Schema the output (or its ```json block) must match' },
    tool_order: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Tool names that must be called in this order (other calls may come between)' },
    tool_args: { type: 'object', additionalProperties: { type: 'object' }, description: 'tool name -> argument values at least one call must carry' },
    max_tool_calls: { type: 'integer', minimum: 0 },
  },
};
if (Object.keys(CHECKS_SCHEMA.properties).sort().join() !== [...CHECKS].sort().join()) throw new Error('CHECKS_SCHEMA is out of sync with CHECKS');

export const SUITE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['suite', 'model', 'cases'],
  properties: {
    suite: { type: 'string', minLength: 1 },
    process: { type: 'string' },
    description: { type: 'string' },
    model: { type: 'object', additionalProperties: false, required: ['id'], properties: { provider: { type: 'string' }, id: { type: 'string', minLength: 1 } } },
    pass_threshold: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'Share of trials that must pass for a case to pass (default 1)' },
    cases: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'checks'],
        properties: { id: { type: 'string', minLength: 1 }, input: { type: 'string' }, notes: { type: 'string' }, checks: CHECKS_SCHEMA, weight: { type: 'number', exclusiveMinimum: 0 }, tags: { type: 'array', items: { type: 'string' } }, critical: { type: 'boolean' } },
      },
    },
  },
};

export const RUBRIC_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['rubric', 'criteria'],
  properties: {
    rubric: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    pass_score: { type: 'number', minimum: 0, maximum: 100, description: 'Percent of points a case needs (default 70)' },
    criteria: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'text', 'points'],
        properties: {
          id: { type: 'string', pattern: '^[A-Za-z0-9_.-]+$' },
          text: { type: 'string', minLength: 3, description: 'The criterion in words; quoted in every grade' },
          points: { type: 'number', exclusiveMinimum: 0 },
          checks: CHECKS_SCHEMA,
          judged: { type: 'boolean', description: 'Scored by a person or your own judge; needs a judgments file' },
          applies_to: { type: 'array', items: { type: 'string' }, description: 'Case ids (default: every case)' },
          applies_to_tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * suite: validated suite. responses: recorded responses (first response per case is graded).
 * judgments: [{ case_id, criterion, score (0..1), quote, rationale?, judge? }]
 */
export function gradeRubric(rubric, suite, responses, judgments = []) {
  const errors = [];
  const ids = new Set();
  for (const c of rubric.criteria) {
    if (ids.has(c.id)) errors.push(`criterion ${c.id}: duplicate id`); ids.add(c.id);
    if (!!c.checks === !!c.judged) errors.push(`criterion ${c.id}: needs exactly one of "checks" or "judged": true`);
    for (const a of c.applies_to || []) if (!suite.cases.some((x) => x.id === a)) errors.push(`criterion ${c.id}: applies_to unknown case ${a}`);
  }
  if (errors.length) throw new Error(`rubric invalid: ${errors.join('; ')}`);
  const byCase = new Map(); for (const r of responses) if (!byCase.has(r.case_id)) byCase.set(r.case_id, r);
  const jmap = new Map(); const rejected = [];
  for (const j of judgments) {
    const crit = rubric.criteria.find((c) => c.id === j.criterion);
    if (!crit) { rejected.push({ case_id: j.case_id, criterion: j.criterion, reason: 'cites a criterion that is not in the rubric' }); continue; }
    if (!crit.judged) { rejected.push({ case_id: j.case_id, criterion: j.criterion, reason: 'criterion is graded by checks, not by judgment' }); continue; }
    if (!byCase.has(j.case_id)) { rejected.push({ case_id: j.case_id, criterion: j.criterion, reason: 'no recorded response for this case' }); continue; }
    jmap.set(`${j.case_id}|${j.criterion}`, j);
  }
  const passScore = Number(rubric.pass_score ?? 70);
  let earnedAll = 0, possibleAll = 0, pending = 0, unverified = 0;
  const results = [];
  for (const c of suite.cases) {
    const resp = byCase.get(c.id);
    const applies = rubric.criteria.filter((k) => (!k.applies_to && !k.applies_to_tags) || (k.applies_to || []).includes(c.id) || (k.applies_to_tags || []).some((t) => (c.tags || []).includes(t)));
    if (!applies.length) continue;
    const criteria = []; let earned = 0, possible = 0;
    for (const k of applies) {
      const cite = { criterion: k.id, text: k.text, points: k.points };
      if (!resp) { criteria.push({ ...cite, earned: 0, status: 'not_met', source: 'none', reason: 'no response recorded' }); possible += k.points; continue; }
      if (k.checks) {
        const r = runChecks(k.checks, resp); const met = r.fails.length === 0;
        criteria.push({ ...cite, earned: met ? k.points : 0, status: met ? 'met' : 'not_met', source: 'check', ...(met ? { evidence: r.evidence[0] || { check: 'checks', quote: 'no forbidden content found' } } : { reason: r.fails.join('; ') }) });
        possible += k.points; if (met) earned += k.points; continue;
      }
      const j = jmap.get(`${c.id}|${k.id}`);
      if (!j) { criteria.push({ ...cite, earned: 0, status: 'pending', source: 'judgment', reason: 'no judgment recorded for this criterion' }); pending++; continue; }
      const score = Math.max(0, Math.min(1, Number(j.score)));
      const q = norm(j.quote);
      const verified = q.length >= 3 && norm(resp.output).includes(q);
      possible += k.points;
      if (!Number.isFinite(Number(j.score))) { criteria.push({ ...cite, earned: 0, status: 'not_met', source: 'judgment', reason: 'judgment has no numeric score (0 to 1)' }); continue; }
      if (!verified) { unverified++; criteria.push({ ...cite, earned: 0, status: 'citation_not_found', source: 'judgment', judge: j.judge || null, reason: q ? `quoted text is not in the recorded output: "${String(j.quote).slice(0, 80)}"` : 'judgment has no quote from the output' }); continue; }
      const e = round2(k.points * score); earned += e;
      criteria.push({ ...cite, earned: e, status: score >= 1 ? 'met' : score > 0 ? 'partly_met' : 'not_met', source: 'judgment', judge: j.judge || null, evidence: { check: 'judgment', quote: String(j.quote).slice(0, 200), verified: true }, ...(j.rationale ? { rationale: String(j.rationale).slice(0, 300) } : {}) });
    }
    const pctScore = possible ? round2((earned / possible) * 100) : 0;
    results.push({ id: c.id, earned: round2(earned), possible, score: pctScore, pass: possible > 0 && pctScore >= passScore, criteria });
    earnedAll += earned; possibleAll += possible;
  }
  return {
    rubric: rubric.rubric, suite: suite.suite, pass_score: passScore,
    cases: results.length, passed: results.filter((r) => r.pass).length,
    earned: round2(earnedAll), possible: possibleAll, score: possibleAll ? round2((earnedAll / possibleAll) * 100) : 0,
    pending, unverified_citations: unverified, rejected_judgments: rejected,
    by_criterion: rubric.criteria.map((k) => { const all = results.flatMap((r) => r.criteria.filter((x) => x.criterion === k.id)); return { criterion: k.id, text: k.text, applied: all.length, met: all.filter((x) => x.status === 'met').length, pending: all.filter((x) => x.status === 'pending').length }; }),
    results,
    note: 'Every grade cites a rubric criterion and the evidence for it. Judged criteria are scored by you or your judge; Agon only checks that each judgment cites a real criterion and quotes text that is in the recorded output. Pending criteria are left out of the score.',
  };
}
