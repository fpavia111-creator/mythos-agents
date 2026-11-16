import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, posix } from 'node:path';
import { tokenize, codeLines, findDependencies } from './lexer.js';

/** SuiteScript 1.0 API -> SuiteScript 2.1 module hint. Hints only; verify against Oracle's docs. */
export const API_MAP = {
  nlapiLoadRecord: 'N/record load()', nlapiSubmitRecord: 'N/record Record.save()', nlapiCreateRecord: 'N/record create()',
  nlapiDeleteRecord: 'N/record delete()', nlapiTransformRecord: 'N/record transform()', nlapiCopyRecord: 'N/record copy()',
  nlapiSubmitField: 'N/record submitFields()', nlapiLookupField: 'N/search lookupFields()', nlapiSearchRecord: 'N/search create()/load() + run()',
  nlapiCreateSearch: 'N/search create()', nlapiLoadSearch: 'N/search load()', nlapiRequestURL: 'N/https request()',
  nlapiSendEmail: 'N/email send()', nlapiLogExecution: 'N/log', nlapiGetContext: 'N/runtime getCurrentScript()/getCurrentUser()',
  nlapiScheduleScript: 'N/task create({taskType: SCHEDULED_SCRIPT})', nlapiYieldScript: 'Map/Reduce script (no direct equivalent)',
  nlapiGetFieldValue: 'currentRecord / context.newRecord getValue()', nlapiSetFieldValue: 'currentRecord setValue()',
  nlapiGetLineItemValue: 'Record getSublistValue()', nlapiSetLineItemValue: 'Record setSublistValue()',
  nlapiGetNewRecord: 'context.newRecord', nlapiGetOldRecord: 'context.oldRecord', nlapiResolveURL: 'N/url resolveRecord()/resolveScript()',
  nlapiLoadFile: 'N/file load()', nlapiCreateFile: 'N/file create()', nlapiSubmitFile: 'N/file File.save()',
  nlapiGetUser: 'N/runtime getCurrentUser().id', nlapiGetRecordId: 'context.newRecord.id', nlapiGetRecordType: 'context.newRecord.type',
  nlapiStringToDate: 'N/format parse()', nlapiDateToString: 'N/format format()', nlapiEscapeXML: 'N/xml escape()',
  nlapiCreateForm: 'N/ui/serverWidget createForm()', nlapiCreateList: 'N/ui/serverWidget createList()',
};

const WRITE_APIS = new Set(['nlapiSubmitRecord', 'nlapiDeleteRecord', 'nlapiTransformRecord', 'nlapiSubmitField', 'nlapiCreateRecord', 'nlapiSubmitFile', 'nlapiCopyRecord']);
const EXTERNAL_APIS = new Set(['nlapiRequestURL', 'nlapiSendEmail']);
const REDESIGN_APIS = new Set(['nlapiYieldScript', 'nlapiScheduleScript', 'nlapiSetRecoveryPoint']);
const EXT = new Set(['.js', '.ss', '.ssp', '.suitescript']);
const API_RE = /^(nlapi[A-Z]\w*|nlobj[A-Z]\w*)$/;

/** Default effort weights (hours). Override with an estimate_config file. */
export const DEFAULT_WEIGHTS = Object.freeze({
  name: 'Epimetheus defaults',
  base_hours: Object.freeze({ '1.0': 3, '2.0': 1, '2.x': 0.5, unknown: 1, '2.1': 0 }),
  per_distinct_api: 0.5, per_call: 0.1, per_100_loc: 0.5, redesign: 4, writes: 1, external: 1, unmapped_api: 0.5, mixed_versions: 1, per_custom_dependency: 0.25,
});

export function walk(dir, root = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, root, out);
    else if (EXT.has(extname(name).toLowerCase()) && st.size < 5_000_000) out.push(p);
  }
  return out;
}

/**
 * Analyse one script's text with a tokenizer, so calls inside comments, strings and
 * regex literals are not counted. Lines are 1-based.
 */
export function analyse(text, file = '') {
  const { tokens, comments } = tokenize(text);
  const doc = comments.map((c) => c.text).join('\n');
  const api = (doc.match(/@NApiVersion\s+([0-9.x]+)/i) || [])[1] || null;
  const type = (doc.match(/@NScriptType\s+(\w+)/i) || [])[1] || null;
  const calls = {}; const hits = [];
  for (const t of tokens) {
    if (t.type !== 'ident' || !API_RE.test(t.value)) continue;
    calls[t.value] = (calls[t.value] || 0) + 1;
    if (hits.length < 200) hits.push({ line: t.line, api: t.value });
  }
  const deps = findDependencies(tokens);
  const modules = [...new Set(deps.filter((d) => d.module.startsWith('N/')).map((d) => d.module))].sort();
  const custom_dependencies = [...new Set(deps.filter((d) => !d.module.startsWith('N/')).map((d) => d.module))];
  const aliases = Object.fromEntries(deps.filter((d) => d.alias).map((d) => [d.alias, d.module]));
  const uses1 = Object.keys(calls).length > 0;
  let version;
  if (api === '2.1') version = '2.1';
  else if (api === '2.0') version = '2.0';
  else if (api && /^2\.x$/i.test(api)) version = '2.x';
  else if (uses1) version = '1.0';
  else version = 'unknown';
  const writes = Object.keys(calls).filter((k) => WRITE_APIS.has(k));
  const external = Object.keys(calls).filter((k) => EXTERNAL_APIS.has(k));
  const unmapped = Object.keys(calls).filter((k) => k.startsWith('nlapi') && !API_MAP[k]).sort();
  const loc = codeLines(tokens).size;
  const reasons = []; let score = 0;
  if (version === '1.0') { score += 50; reasons.push('SuiteScript 1.0 (must move to 2.1 per the 2028.2 notice)'); }
  else if (version === '2.0') { score += 25; reasons.push('SuiteScript 2.0 (must move to 2.1 per the 2028.2 notice)'); }
  else if (version === '2.x') { score += 10; reasons.push('@NApiVersion 2.x: confirm which version your account resolves it to'); }
  else if (version === 'unknown') { score += 5; reasons.push('No @NApiVersion and no 1.0 calls found: check manually'); }
  if ((version === '2.0' || version === '2.x' || version === '2.1') && uses1) { score += 10; reasons.push('Declares 2.x/2.0 but contains nlapi/nlobj calls'); }
  if (writes.length) { score += 15; reasons.push(`Writes records (${writes.join(', ')})`); }
  if (external.length) { score += 10; reasons.push(`External effects (${external.join(', ')})`); }
  const redesign = Object.keys(calls).filter((k) => REDESIGN_APIS.has(k));
  if (redesign.length) { score += 10; reasons.push('Scheduling / yield logic: likely a Map/Reduce redesign, not a line-by-line port'); }
  if (loc > 300) { score += 10; reasons.push(`Large file (${loc} lines of code)`); } else if (loc > 100) { score += 5; reasons.push(`Medium file (${loc} lines of code)`); }
  const distinct = Object.keys(calls).length;
  if (distinct > 8) { score += 5; reasons.push(`${distinct} distinct 1.0 APIs`); }
  if (unmapped.length) reasons.push(`No mapping hint in Epimetheus for ${unmapped.join(', ')}: look these up in Oracle's API map`);
  score = Math.min(100, score);
  const risk = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
  return {
    file, version, declared_api: api, script_type: type, loc, calls, call_count: Object.values(calls).reduce((a, b) => a + b, 0),
    writes, external, redesign, unmapped, modules, custom_dependencies, aliases, score, risk, reasons, hits,
  };
}

const q = (h) => Math.round(h * 4) / 4;

/**
 * Rough, deterministic planning estimate in hours, explained by the signals it counted.
 * Same file + same weights = same number. Not a quote.
 */
export function estimateEffort(a, weights = DEFAULT_WEIGHTS) {
  const w = { ...DEFAULT_WEIGHTS, ...weights, base_hours: { ...DEFAULT_WEIGHTS.base_hours, ...(weights.base_hours || {}) } };
  if (a.version === '2.1' && !a.call_count) return { hours: 0, signals: [], weights: w.name };
  const distinct = Object.keys(a.calls).length;
  const sig = [
    ['version', `SuiteScript ${a.version}`, 1, w.base_hours[a.version] ?? 0],
    ['distinct_apis', `${distinct} distinct 1.0 API(s)`, distinct, w.per_distinct_api],
    ['calls', `${a.call_count} 1.0 call(s)`, a.call_count, w.per_call],
    ['size', `${a.loc} lines of code`, a.loc / 100, w.per_100_loc],
    ['redesign', 'scheduling/yield logic (redesign)', a.redesign.length ? 1 : 0, w.redesign],
    ['writes', 'writes records (more testing)', a.writes.length ? 1 : 0, w.writes],
    ['external', 'outbound HTTP/email (more testing)', a.external.length ? 1 : 0, w.external],
    ['unmapped', `${a.unmapped.length} API(s) with no mapping hint`, a.unmapped.length, w.unmapped_api],
    ['mixed', 'declares 2.x but has 1.0 calls', a.version !== '1.0' && a.call_count ? 1 : 0, w.mixed_versions],
    ['custom_dependencies', `${a.custom_dependencies.length} custom module dependenc${a.custom_dependencies.length === 1 ? 'y' : 'ies'}`, a.custom_dependencies.length, w.per_custom_dependency],
  ];
  const signals = sig.filter(([, , count, rate]) => count && rate).map(([id, label, count, rate]) => ({ signal: id, label, count: Math.round(count * 100) / 100, hours: q(count * rate) })).filter((s) => s.hours > 0);
  return { hours: q(signals.reduce((x, s) => x + s.hours, 0)), signals, weights: w.name };
}

export function inventory(dir, { weights } = {}) {
  const files = walk(dir);
  const items = files.map((f) => {
    const a = { ...analyse(readFileSync(f, 'utf8')), file: relative(dir, f).split('\\').join('/') };
    a.effort = estimateEffort(a, weights);
    return a;
  });
  items.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const byVersion = {}; const byRisk = { high: 0, medium: 0, low: 0 };
  for (const i of items) { byVersion[i.version] = (byVersion[i.version] || 0) + 1; byRisk[i.risk]++; }
  return {
    files: items.length, by_version: byVersion, by_risk: byRisk, needs_2_1: items.filter((i) => i.version !== '2.1').length,
    effort_hours: q(items.reduce((x, i) => x + i.effort.hours, 0)), effort_weights: (weights && weights.name) || DEFAULT_WEIGHTS.name,
    items,
  };
}

// ---- Dependency graph ----------------------------------------------------------------

function resolveDep(from, dep, fileSet) {
  const withExt = (p) => (/\.(js|ss|ssp|suitescript)$/i.test(p) ? [p] : [p + '.js', p]);
  if (dep.startsWith('./') || dep.startsWith('../')) {
    const base = posix.normalize(posix.join(posix.dirname(from), dep));
    for (const c of withExt(base)) if (fileSet.has(c)) return c;
    return null;
  }
  // Absolute File Cabinet path (/SuiteScripts/lib/x) or bare path: match the longest path suffix.
  const parts = dep.replace(/^\/+/, '').split('/');
  for (let s = 0; s < parts.length; s++) {
    const tail = parts.slice(s).join('/');
    for (const c of withExt(tail)) {
      const hits = [...fileSet].filter((f) => f === c || f.endsWith('/' + c)).sort();
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) return null; // ambiguous: report, don't guess
    }
  }
  return null;
}

/** Tarjan's strongly connected components. Deterministic for sorted input. */
function scc(nodes, adj) {
  let index = 0; const st = []; const on = new Set(); const idx = new Map(); const low = new Map(); const out = [];
  const visit = (v) => {
    idx.set(v, index); low.set(v, index); index++; st.push(v); on.add(v);
    for (const w of adj.get(v) || []) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) { const comp = []; let w; do { w = st.pop(); on.delete(w); comp.push(w); } while (w !== v); out.push(comp.sort()); }
  };
  for (const v of nodes) if (!idx.has(v)) visit(v);
  return out;
}

/**
 * Build the custom-module dependency graph and a stable conversion order
 * (dependencies first; ties broken by file name). Cycles are reported and kept
 * together as one step.
 */
export function dependencyGraph(inv) {
  const files = inv.items.map((i) => i.file).sort();
  const fileSet = new Set(files);
  const byFile = new Map(inv.items.map((i) => [i.file, i]));
  const edges = []; const unresolved = []; const adj = new Map(files.map((f) => [f, []]));
  for (const f of files) {
    for (const dep of byFile.get(f).custom_dependencies) {
      const to = resolveDep(f, dep, fileSet);
      if (to && to !== f) { edges.push({ from: f, to, module: dep }); if (!adj.get(f).includes(to)) adj.get(f).push(to); } else if (!to) unresolved.push({ file: f, module: dep });
    }
    adj.get(f).sort();
  }
  const comps = scc(files, adj);
  const cycles = comps.filter((c) => c.length > 1 || (adj.get(c[0]) || []).includes(c[0]));
  // Condensed graph; order = dependencies before dependents (Kahn's algorithm on reversed edges, sorted queue).
  const compOf = new Map(); comps.forEach((c, i) => c.forEach((f) => compOf.set(f, i)));
  const deps = comps.map(() => new Set()); const dependents = comps.map(() => new Set());
  for (const e of edges) { const a = compOf.get(e.from), b = compOf.get(e.to); if (a !== b) { deps[a].add(b); dependents[b].add(a); } }
  const remaining = deps.map((s) => s.size);
  const label = (i) => comps[i][0];
  let ready = comps.map((_, i) => i).filter((i) => remaining[i] === 0).sort((a, b) => label(a).localeCompare(label(b)));
  const steps = [];
  while (ready.length) {
    const i = ready.shift();
    steps.push(comps[i]);
    for (const d of [...dependents[i]]) { remaining[d]--; if (remaining[d] === 0) ready.push(d); }
    ready.sort((a, b) => label(a).localeCompare(label(b)));
  }
  const order = steps.flatMap((s) => s);
  const id = new Map(files.map((f, i) => [f, `f${i}`]));
  const mermaid = ['graph LR', ...files.map((f) => `  ${id.get(f)}["${f} (${byFile.get(f).version})"]`), ...edges.map((e) => `  ${id.get(e.from)} --> ${id.get(e.to)}`)].join('\n');
  return {
    nodes: files.map((f) => ({ file: f, version: byFile.get(f).version, depends_on: adj.get(f), used_by: edges.filter((e) => e.to === f).map((e) => e.from).sort() })),
    edges, cycles, unresolved,
    order: order.map((f, n) => ({ step: steps.findIndex((s) => s.includes(f)) + 1, n: n + 1, file: f, version: byFile.get(f).version, in_cycle: cycles.some((c) => c.includes(f)) })),
    mermaid,
  };
}

// ---- Progress against a baseline inventory.csv ------------------------------------------

/** Compare a previous inventory.csv (rows) with the current inventory. */
export function progress(baselineRows, inv) {
  const prev = new Map(baselineRows.map((r) => [String(r.file), r]));
  const cur = new Map(inv.items.map((i) => [i.file, i]));
  const converted = []; const regressed = []; const improved = []; const unchanged = [];
  for (const [f, i] of cur) {
    const p = prev.get(f); if (!p) continue;
    const ps = Number(p.score), pv = String(p.version);
    const row = { file: f, previous_version: pv, version: i.version, previous_score: ps, score: i.score };
    if (pv !== '2.1' && i.version === '2.1') converted.push(row);
    else if (i.score > ps || (pv === '2.1' && i.version !== '2.1')) regressed.push(row);
    else if (i.score < ps) improved.push(row);
    else unchanged.push(row);
  }
  const added = [...cur.keys()].filter((f) => !prev.has(f)).sort().map((f) => ({ file: f, version: cur.get(f).version, score: cur.get(f).score }));
  const removed = [...prev.keys()].filter((f) => !cur.has(f)).sort().map((f) => ({ file: f, previous_version: prev.get(f).version }));
  const prevNeeds = baselineRows.filter((r) => String(r.version) !== '2.1').length;
  const prevHours = baselineRows.reduce((x, r) => x + (Number(r.effort_hours) || 0), 0);
  return {
    previous: { files: baselineRows.length, needs_2_1: prevNeeds, effort_hours: baselineRows.some((r) => r.effort_hours !== undefined && r.effort_hours !== '') ? q(prevHours) : null },
    current: { files: inv.files, needs_2_1: inv.needs_2_1, effort_hours: inv.effort_hours },
    converted, improved, regressed, unchanged: unchanged.length, added, removed,
    percent_on_2_1: inv.files ? Math.round(((inv.files - inv.needs_2_1) / inv.files) * 1000) / 10 : 0,
  };
}

// ---- SARIF ----------------------------------------------------------------------------

export const SARIF_RULES = [
  { id: 'EPI001', name: 'SuiteScript1ApiCall', description: 'SuiteScript 1.0 API call (must move to 2.1)', severity: 'warning', help: 'Replace with the SuiteScript 2.1 module shown in the message, then test the behaviour in a sandbox.' },
  { id: 'EPI002', name: 'SuiteScript20File', description: 'File declares @NApiVersion 2.0', severity: 'warning', help: 'Change to 2.1 and retest; 2.0 must move to 2.1 per the 2028.2 notice.' },
  { id: 'EPI003', name: 'SuiteScript2xFile', description: 'File declares @NApiVersion 2.x', severity: 'note', help: 'Confirm which version your account resolves 2.x to.' },
  { id: 'EPI004', name: 'UnknownVersion', description: 'No @NApiVersion and no 1.0 calls found', severity: 'note', help: 'Check this file by hand.' },
  { id: 'EPI005', name: 'RedesignNeeded', description: 'Scheduling or yield logic (likely a Map/Reduce redesign)', severity: 'error', help: 'Plan a redesign rather than a line-by-line port.' },
];

export function sarifFindings(inv, prefix = '') {
  const out = [];
  const path = (f) => (prefix ? `${prefix.replace(/\/+$/, '')}/${f}` : f);
  for (const i of inv.items) {
    if (i.version === '2.0') out.push({ ruleId: 'EPI002', message: `${i.file} declares @NApiVersion 2.0`, file: path(i.file), line: 1 });
    if (i.version === '2.x') out.push({ ruleId: 'EPI003', message: `${i.file} declares @NApiVersion 2.x`, file: path(i.file), line: 1 });
    if (i.version === 'unknown') out.push({ ruleId: 'EPI004', message: `${i.file}: no @NApiVersion and no 1.0 calls found`, file: path(i.file), line: 1 });
    for (const h of i.hits) {
      out.push({ ruleId: REDESIGN_APIS.has(h.api) ? 'EPI005' : 'EPI001', message: `${h.api} → ${API_MAP[h.api] || "no hint; see Oracle's SuiteScript 1.0 to 2.x API map"}`, file: path(i.file), line: h.line, severity: REDESIGN_APIS.has(h.api) ? 'error' : undefined });
    }
  }
  return out;
}

export function testPlanMarkdown(inv, generatedAt, graph = null) {
  const L = ['# SuiteScript 2.1 conversion and test plan (draft)', '', `Generated ${generatedAt} by epimetheus-of-scripts from a local folder scan. A starting point for a human-reviewed plan, not a finished one.`, ''];
  L.push('## Summary', '', `- Files scanned: ${inv.files}`, `- Not yet on 2.1: ${inv.needs_2_1}`, `- By version: ${Object.entries(inv.by_version).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}`, `- By risk: high ${inv.by_risk.high}, medium ${inv.by_risk.medium}, low ${inv.by_risk.low}`, `- Rough effort: ${inv.effort_hours} hour(s) (weights: ${inv.effort_weights}; a planning estimate from counted signals, not a quote)`, '');
  L.push('Oracle has announced that custom scripts must run on SuiteScript 2.1 by NetSuite 2028.2. Confirm the dates and scope against the notice in your own account.', '');
  if (graph && graph.edges.length) {
    L.push('## Conversion order by dependency (libraries first)', '');
    for (const o of graph.order) L.push(`${o.n}. \`${o.file}\` (${o.version})${o.in_cycle ? ' — in a dependency cycle; convert and test together' : ''}`);
    if (graph.cycles.length) L.push('', `Cycles: ${graph.cycles.map((c) => c.join(' ↔ ')).join('; ')}`);
    if (graph.unresolved.length) L.push('', `Unresolved custom modules (check paths): ${graph.unresolved.map((u) => `\`${u.module}\` in ${u.file}`).join(', ')}`);
    L.push('');
  }
  L.push('## Order of work (highest risk first)', '');
  inv.items.filter((i) => i.version !== '2.1' || i.call_count).forEach((i, n) => {
    L.push(`### ${n + 1}. \`${i.file}\` — ${i.risk} (${i.score})`, '', `- Version: ${i.version}${i.script_type ? ` · Type: ${i.script_type}` : ''} · ${i.loc} lines of code`);
    for (const r of i.reasons) L.push(`- ${r}`);
    const apis = Object.keys(i.calls);
    if (apis.length) L.push(`- API mapping hints: ${apis.map((a) => `\`${a}\` → ${API_MAP[a] || 'look up'}`).join('; ')}`);
    if (i.effort) L.push(`- Rough effort: ${i.effort.hours} h (${i.effort.signals.map((s) => `${s.label}: ${s.hours} h`).join('; ') || 'no signals'})`);
    L.push('- Tests before deploy: run in a sandbox; compare record values written before and after; check governance usage; check error paths; get a named reviewer\'s sign-off.', '');
  });
  L.push('## Rules', '', '- Epimetheus does not convert or deploy code. Converted code goes through your normal review and SDF/release process.', '- Mapping hints are a starting point. Behaviour differences between 1.0 and 2.1 must be tested, not assumed.', '- Effort figures come from fixed weights applied to counted signals; calibrate them with an estimate_config file.', '');
  return L.join('\n');
}
