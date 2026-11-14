import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

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
const EXT = new Set(['.js', '.ss', '.ssp', '.suitescript']);

export function walk(dir, root = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, root, out);
    else if (EXT.has(extname(name).toLowerCase()) && st.size < 5_000_000) out.push(p);
  }
  return out;
}

/** Analyse one script's text. Lines are 1-based. */
export function analyse(text, file = '') {
  const lines = text.split(/\r?\n/);
  const api = (text.match(/@NApiVersion\s+([0-9.x]+)/i) || [])[1] || null;
  const type = (text.match(/@NScriptType\s+(\w+)/i) || [])[1] || null;
  const calls = {}; const hits = [];
  const re = /\b(nlapi[A-Z]\w*|nlobj[A-Z]\w*)\b/g;
  lines.forEach((ln, i) => {
    if (/^\s*(\/\/|\*)/.test(ln)) return;
    let m; re.lastIndex = 0;
    while ((m = re.exec(ln))) { calls[m[1]] = (calls[m[1]] || 0) + 1; if (hits.length < 200) hits.push({ line: i + 1, api: m[1] }); }
  });
  const uses1 = Object.keys(calls).length > 0;
  let version;
  if (api === '2.1') version = '2.1';
  else if (api === '2.0') version = '2.0';
  else if (api && /^2\.x$/i.test(api)) version = '2.x';
  else if (uses1) version = '1.0';
  else version = 'unknown';
  const writes = Object.keys(calls).filter((k) => WRITE_APIS.has(k));
  const external = Object.keys(calls).filter((k) => EXTERNAL_APIS.has(k));
  const loc = lines.filter((l) => l.trim() && !/^\s*(\/\/|\*|\/\*)/.test(l)).length;
  const reasons = []; let score = 0;
  if (version === '1.0') { score += 50; reasons.push('SuiteScript 1.0 (must move to 2.1 per the 2028.2 notice)'); }
  else if (version === '2.0') { score += 25; reasons.push('SuiteScript 2.0 (must move to 2.1 per the 2028.2 notice)'); }
  else if (version === '2.x') { score += 10; reasons.push('@NApiVersion 2.x: confirm which version your account resolves it to'); }
  else if (version === 'unknown') { score += 5; reasons.push('No @NApiVersion and no 1.0 calls found: check manually'); }
  if (version === '2.0' && uses1) { score += 10; reasons.push('Declares 2.x/2.0 but contains nlapi/nlobj calls'); }
  if (writes.length) { score += 15; reasons.push(`Writes records (${writes.join(', ')})`); }
  if (external.length) { score += 10; reasons.push(`External effects (${external.join(', ')})`); }
  if (/nlapiYieldScript|nlapiScheduleScript/.test(text)) { score += 10; reasons.push('Scheduling / yield logic: likely a Map/Reduce redesign, not a line-by-line port'); }
  if (loc > 300) { score += 10; reasons.push(`Large file (${loc} lines of code)`); } else if (loc > 100) { score += 5; reasons.push(`Medium file (${loc} lines of code)`); }
  const distinct = Object.keys(calls).length;
  if (distinct > 8) { score += 5; reasons.push(`${distinct} distinct 1.0 APIs`); }
  score = Math.min(100, score);
  const risk = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
  return { file, version, declared_api: api, script_type: type, loc, calls, call_count: Object.values(calls).reduce((a, b) => a + b, 0), writes, external, score, risk, reasons, hits };
}

export function inventory(dir) {
  const files = walk(dir);
  const items = files.map((f) => ({ ...analyse(readFileSync(f, 'utf8')), file: relative(dir, f).split('\\').join('/') }));
  items.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const byVersion = {}; const byRisk = { high: 0, medium: 0, low: 0 };
  for (const i of items) { byVersion[i.version] = (byVersion[i.version] || 0) + 1; byRisk[i.risk]++; }
  return { files: items.length, by_version: byVersion, by_risk: byRisk, needs_2_1: items.filter((i) => i.version !== '2.1').length, items };
}

export function testPlanMarkdown(inv, generatedAt) {
  const L = ['# SuiteScript 2.1 conversion and test plan (draft)', '', `Generated ${generatedAt} by epimetheus-of-scripts from a local folder scan. A starting point for a human-reviewed plan, not a finished one.`, ''];
  L.push('## Summary', '', `- Files scanned: ${inv.files}`, `- Not yet on 2.1: ${inv.needs_2_1}`, `- By version: ${Object.entries(inv.by_version).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}`, `- By risk: high ${inv.by_risk.high}, medium ${inv.by_risk.medium}, low ${inv.by_risk.low}`, '');
  L.push('Oracle has announced that custom scripts must run on SuiteScript 2.1 by NetSuite 2028.2. Confirm the dates and scope against the notice in your own account.', '');
  L.push('## Order of work (highest risk first)', '');
  inv.items.filter((i) => i.version !== '2.1').forEach((i, n) => {
    L.push(`### ${n + 1}. \`${i.file}\` — ${i.risk} (${i.score})`, '', `- Version: ${i.version}${i.script_type ? ` · Type: ${i.script_type}` : ''} · ${i.loc} lines of code`);
    for (const r of i.reasons) L.push(`- ${r}`);
    const apis = Object.keys(i.calls);
    if (apis.length) L.push(`- API mapping hints: ${apis.map((a) => `\`${a}\` → ${API_MAP[a] || 'look up'}`).join('; ')}`);
    L.push('- Tests before deploy: run in a sandbox; compare record values written before and after; check governance usage; check error paths; get a named reviewer\'s sign-off.', '');
  });
  L.push('## Rules', '', '- Epimetheus does not convert or deploy code. Converted code goes through your normal review and SDF/release process.', '- Mapping hints are a starting point. Behaviour differences between 1.0 and 2.1 must be tested, not assumed.', '');
  return L.join('\n');
}
