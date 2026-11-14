// Lycurgus of Licenses: apply a written license policy to an npm project's dependencies.
// Reads package-lock.json and installed package.json files. Writes nothing in the project.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const LIMITS = 'Lycurgus applies the policy you wrote to the license each package declares in its metadata. It does not read source files, notices or license texts for hidden terms, it does not decide what a license allows, and it is not legal advice. A pass means "matches your policy as written", not "cleared for distribution".';
export const DECISIONS = ['allow', 'review', 'unknown', 'deny'];
const RANK = { allow: 0, review: 1, unknown: 2, deny: 3 };
const ALIASES = {
  'mit license': 'MIT', 'the mit license': 'MIT', 'apache 2.0': 'Apache-2.0', 'apache-2': 'Apache-2.0', 'apache license 2.0': 'Apache-2.0', 'apache license, version 2.0': 'Apache-2.0', 'apache2': 'Apache-2.0',
  'isc license': 'ISC', 'bsd': 'BSD-UNSPECIFIED', 'new bsd': 'BSD-3-Clause', 'bsd 3-clause': 'BSD-3-Clause', 'bsd-3': 'BSD-3-Clause', 'bsd 2-clause': 'BSD-2-Clause',
  'gplv2': 'GPL-2.0-only', 'gplv3': 'GPL-3.0-only', 'gpl-2.0': 'GPL-2.0-only', 'gpl-3.0': 'GPL-3.0-only', 'lgpl-2.1': 'LGPL-2.1-only', 'lgpl-3.0': 'LGPL-3.0-only', 'agpl-3.0': 'AGPL-3.0-only',
  'gpl-2.0+': 'GPL-2.0-or-later', 'gpl-3.0+': 'GPL-3.0-or-later', 'lgpl-2.1+': 'LGPL-2.1-or-later', 'public domain': 'LicenseRef-Public-Domain', 'wtfpl': 'WTFPL', 'unlicense': 'Unlicense', 'cc0': 'CC0-1.0',
};

export function validatePolicy(p) {
  if (!p || typeof p !== 'object') throw new Error('policy must be a JSON object');
  if (!String(p.source || '').trim()) throw new Error('policy.source is required (name and version of your written license policy)');
  for (const k of ['allow', 'review', 'deny']) if (p[k] !== undefined && !Array.isArray(p[k])) throw new Error(`policy.${k} must be an array of SPDX ids or patterns`);
  if (!Array.isArray(p.allow) || !p.allow.length) throw new Error('policy.allow must list at least one license');
  if (p.unknown && !['review', 'deny'].includes(p.unknown)) throw new Error('policy.unknown must be "review" or "deny"');
  if (p.dev_dependencies && !['include', 'ignore'].includes(p.dev_dependencies)) throw new Error('policy.dev_dependencies must be "include" or "ignore"');
  return { unknown: 'review', proprietary: 'review', dev_dependencies: 'include', review: [], deny: [], exceptions: [], sections: {}, ...p };
}

export function tokenize(expr) {
  return String(expr).replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').trim().split(/\s+/).filter(Boolean);
}
/** Parse an SPDX expression into a tree: {id, exception} | {op:'AND'|'OR', args}. Throws on bad syntax. */
export function parseExpression(expr) {
  const t = tokenize(expr); let i = 0;
  const peek = () => t[i]; const up = (x) => String(x || '').toUpperCase();
  function atom() {
    const x = t[i++];
    if (x === undefined) throw new Error('expression ends early');
    if (x === '(') { const e = or(); if (t[i++] !== ')') throw new Error('missing ")"'); return e; }
    if (x === ')' || ['AND', 'OR', 'WITH'].includes(up(x))) throw new Error(`unexpected "${x}"`);
    const node = { id: x };
    if (up(peek()) === 'WITH') { i++; const ex = t[i++]; if (!ex || ex === '(' || ex === ')') throw new Error('WITH needs an exception id'); node.exception = ex; }
    return node;
  }
  function and() { const args = [atom()]; while (up(peek()) === 'AND') { i++; args.push(atom()); } return args.length === 1 ? args[0] : { op: 'AND', args }; }
  function or() { const args = [and()]; while (up(peek()) === 'OR') { i++; args.push(and()); } return args.length === 1 ? args[0] : { op: 'OR', args }; }
  const e = or(); if (i < t.length) throw new Error(`unexpected "${t[i]}"`); return e;
}

const pattern = (p) => new RegExp('^' + String(p).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
const listHas = (list, id) => (list || []).some((p) => pattern(p).test(id));

export function normalizeLicense(raw) {
  if (raw === undefined || raw === null || raw === '') return { expression: null, normalized: false };
  let s = raw;
  if (Array.isArray(raw)) s = raw.map((x) => (typeof x === 'string' ? x : x?.type)).filter(Boolean).join(' OR ');
  else if (typeof raw === 'object') s = raw.type || '';
  s = String(s).trim();
  if (!s) return { expression: null, normalized: false };
  const alias = ALIASES[s.toLowerCase()];
  if (alias) return { expression: alias, normalized: alias !== s, raw: s };
  return { expression: s, normalized: Array.isArray(raw) || typeof raw === 'object', raw: s };
}

function classifyId(node, policy) {
  const full = node.exception ? `${node.id} WITH ${node.exception}` : node.id;
  if (/^UNLICENSED$/i.test(node.id)) return { decision: policy.proprietary === 'deny' ? 'deny' : 'review', why: 'UNLICENSED (proprietary, no open-source license)' };
  // Entries with WITH only match an id with that exception; plain entries and patterns match the id alone.
  const lists = (d) => (policy[d] || []).filter((x) => / WITH /i.test(x) === !!node.exception);
  for (const d of ['deny', 'allow', 'review']) {
    if (listHas(lists(d), full)) return { decision: d, why: `${full} is on the ${d} list` };
  }
  if (node.exception) for (const d of ['deny', 'allow', 'review']) if (listHas(policy[d], node.id)) return { decision: d === 'allow' ? 'review' : d, why: `${node.id} is on the ${d} list; the "${node.exception}" exception is not, so it needs a look` };
  return { decision: 'unknown', why: `${full} is not on any list in the policy` };
}
export function evaluate(tree, policy) {
  if (tree.id) return classifyId(tree, policy);
  const parts = tree.args.map((a) => evaluate(a, policy));
  const pick = tree.op === 'OR' ? parts.reduce((a, b) => (RANK[b.decision] < RANK[a.decision] ? b : a)) : parts.reduce((a, b) => (RANK[b.decision] > RANK[a.decision] ? b : a));
  return { decision: pick.decision, why: tree.op === 'OR' ? `choice of licenses; best option: ${pick.why}` : `all apply; strictest: ${pick.why}` };
}

const installedLicense = (projectDir, key) => {
  const f = join(projectDir, key, 'package.json');
  if (!existsSync(f)) return undefined;
  try { const p = JSON.parse(readFileSync(f, 'utf8')); return p.license ?? p.licenses ?? null; } catch { return undefined; }
};
const nameFromKey = (key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);

export function readProject(projectDir) {
  const pjf = join(projectDir, 'package.json'); const lockf = join(projectDir, 'package-lock.json');
  if (!existsSync(pjf)) throw new Error('package.json not found in the project folder');
  const pj = JSON.parse(readFileSync(pjf, 'utf8'));
  const pkgs = []; let lockText = null; let lockVersion = null;
  if (existsSync(lockf)) {
    lockText = readFileSync(lockf, 'utf8'); const lock = JSON.parse(lockText); lockVersion = lock.lockfileVersion;
    if (lock.packages) {
      for (const [key, v] of Object.entries(lock.packages)) {
        if (!key || !key.includes('node_modules/')) continue;
        if (v.link) { pkgs.push({ key, name: nameFromKey(key), version: v.version || null, link: true }); continue; }
        pkgs.push({ key, name: nameFromKey(key), version: v.version || null, lock_license: v.license, dev: !!v.dev, optional: !!v.optional, installed_license: installedLicense(projectDir, key) });
      }
    } else if (lock.dependencies) {
      const walk = (deps, prefix) => { for (const [n, v] of Object.entries(deps)) { const key = `${prefix}node_modules/${n}`; pkgs.push({ key, name: n, version: v.version || null, dev: !!v.dev, installed_license: installedLicense(projectDir, key) }); if (v.dependencies) walk(v.dependencies, `${key}/`); } };
      walk(lock.dependencies, '');
    }
  } else if (existsSync(join(projectDir, 'node_modules'))) {
    for (const n of readdirSync(join(projectDir, 'node_modules'))) {
      if (n.startsWith('.')) continue;
      const names = n.startsWith('@') ? readdirSync(join(projectDir, 'node_modules', n)).map((x) => `${n}/${x}`) : [n];
      for (const name of names) { const key = `node_modules/${name}`; const f = join(projectDir, key, 'package.json'); if (!existsSync(f)) continue; const p = JSON.parse(readFileSync(f, 'utf8')); pkgs.push({ key, name, version: p.version || null, installed_license: p.license ?? p.licenses ?? null }); }
    }
  } else throw new Error('no package-lock.json or node_modules in the project folder; run npm install first');
  return { pj, pkgs, lockText, lockVersion, hasLicenseFile: readdirSync(projectDir).some((f) => /^(LICEN[CS]E|COPYING)(\.|$)/i.test(f)) };
}

function exceptionFor(policy, name, version, asOf) {
  const ex = (policy.exceptions || []).find((e) => e.package === name && (!e.version || e.version === '*' || e.version === version));
  if (!ex) return null;
  if (!String(ex.approved_by || '').trim()) return { ex, state: 'unapproved' };
  if (ex.expires && Date.parse(ex.expires) < asOf) return { ex, state: 'expired' };
  return { ex, state: 'active' };
}

export function check(projectDir, policyIn, { as_of, include_dev } = {}) {
  const policy = validatePolicy(policyIn);
  const asOf = as_of ? Date.parse(as_of) : Date.now();
  if (Number.isNaN(asOf)) throw new Error('as_of must be a date like 2026-11-14');
  const proj = readProject(projectDir);
  const sec = (k) => policy.sections[k] || null;
  const dev = include_dev ?? policy.dev_dependencies !== 'ignore';
  const packages = []; const findings = []; const skipped = [];
  const add = (f) => findings.push(f);
  for (const p of proj.pkgs) {
    if (p.link) { skipped.push({ name: p.name, why: 'workspace link (your own code)' }); continue; }
    if (p.dev && !dev) { skipped.push({ name: p.name, why: 'dev dependency (policy ignores them)' }); continue; }
    const fromLock = normalizeLicense(p.lock_license); const fromPkg = normalizeLicense(p.installed_license);
    const lic = fromLock.expression ? fromLock : fromPkg;
    const src = fromLock.expression ? 'package-lock.json' : fromPkg.expression ? 'package.json' : 'none';
    const row = { name: p.name, version: p.version, key: p.key, dev: !!p.dev, license: lic.expression, license_source: src, decision: null, why: '', policy_section: null, exception: null };
    if (fromLock.expression && fromPkg.expression && fromLock.expression !== fromPkg.expression) add({ check: 'license_mismatch', severity: 'warning', package: p.name, version: p.version, detail: `package-lock.json says ${fromLock.expression}; the installed package.json says ${fromPkg.expression}. The lockfile value is used.` });
    if (lic.normalized) add({ check: 'license_normalized', severity: 'advisory', package: p.name, version: p.version, detail: `Declared as "${lic.raw}"; read as the SPDX id ${lic.expression}.` });
    let res;
    if (!lic.expression) res = { decision: policy.unknown === 'deny' ? 'deny' : 'unknown', why: 'no license declared', section: sec('unknown'), check: 'no_license' };
    else if (/^SEE LICEN[CS]E IN /i.test(lic.expression)) res = { decision: policy.unknown === 'deny' ? 'deny' : 'unknown', why: `custom license file (${lic.expression}); a person must read it`, section: sec('unknown'), check: 'custom_license' };
    else {
      let tree; try { tree = parseExpression(lic.expression); } catch (e) { tree = null; res = { decision: policy.unknown === 'deny' ? 'deny' : 'unknown', why: `not a valid SPDX expression (${e.message})`, section: sec('unknown'), check: 'bad_expression' }; }
      if (tree) { const ev = evaluate(tree, policy); res = { decision: ev.decision === 'unknown' && policy.unknown === 'deny' ? 'deny' : ev.decision, why: ev.why, section: sec(ev.decision), check: { deny: 'denied', review: 'needs_review', unknown: 'unknown_license', allow: null }[ev.decision] }; }
    }
    const exc = res.decision !== 'allow' ? exceptionFor(policy, p.name, p.version, asOf) : null;
    if (exc?.state === 'active') { row.exception = { reason: exc.ex.reason || '', approved_by: exc.ex.approved_by, expires: exc.ex.expires || null }; add({ check: 'exception_applied', severity: 'advisory', package: p.name, version: p.version, detail: `${res.why}; allowed by the exception approved by ${exc.ex.approved_by}${exc.ex.expires ? ` until ${exc.ex.expires}` : ''}.`, policy_section: sec('exceptions') }); res = { ...res, decision: 'allow', check: null };
    } else if (exc) add({ check: exc.state === 'expired' ? 'exception_expired' : 'exception_unapproved', severity: 'warning', package: p.name, version: p.version, detail: exc.state === 'expired' ? `The exception expired on ${exc.ex.expires}, so it no longer applies.` : 'The exception has no approved_by, so it does not apply.', policy_section: sec('exceptions') });
    row.decision = res.decision; row.why = res.why; row.policy_section = res.section;
    if (res.check) add({ check: res.check, severity: res.decision === 'deny' ? 'error' : 'warning', package: p.name, version: p.version, detail: `${p.name}@${p.version} (${lic.expression || 'none'}): ${res.why}.`, policy_section: res.section });
    packages.push(row);
  }
  if (!proj.pj.license) add({ check: 'project_license_missing', severity: 'warning', package: proj.pj.name || '(project)', version: proj.pj.version || null, detail: 'Your package.json has no license field.' });
  if (!proj.hasLicenseFile) add({ check: 'license_file_missing', severity: 'warning', package: proj.pj.name || '(project)', version: proj.pj.version || null, detail: 'No LICENSE, LICENCE or COPYING file in the project folder.' });
  const counts = {}; for (const p of packages) counts[p.decision] = (counts[p.decision] || 0) + 1;
  const result = counts.deny ? 'fail' : counts.review || counts.unknown ? 'pass_with_review' : 'pass';
  const sev = { error: 0, warning: 1, advisory: 2 };
  findings.sort((a, b) => sev[a.severity] - sev[b.severity]);
  return { project: { name: proj.pj.name || null, version: proj.pj.version || null, license: proj.pj.license || null }, policy_source: policy.source, lockfile_version: proj.lockVersion, include_dev: dev, as_of: new Date(asOf).toISOString().slice(0, 10), check: result, counts, packages, skipped, findings, issues: findings.filter((f) => f.severity !== 'advisory').length, limits: LIMITS, _lockText: proj.lockText };
}

const purl = (n, v) => `pkg:npm/${n.startsWith('@') ? '%40' + n.slice(1) : n}${v ? '@' + v : ''}`;
export function sbom(r, tool) {
  return {
    bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    metadata: { timestamp: new Date().toISOString(), tools: { components: [{ type: 'application', name: tool.name, version: tool.version }] }, component: { type: 'application', name: r.project.name || 'project', version: r.project.version || '0.0.0', ...(r.project.license ? { licenses: [{ expression: r.project.license }] } : {}) } },
    components: r.packages.map((p) => ({ type: 'library', 'bom-ref': purl(p.name, p.version), name: p.name, version: p.version || '', purl: purl(p.name, p.version), scope: p.dev ? 'excluded' : 'required', ...(p.license ? { licenses: [{ expression: p.license }] } : {}) })),
  };
}
const RULES = { denied: 'License is on the deny list', needs_review: 'License needs review under the policy', unknown_license: 'License is not covered by the policy', no_license: 'No license declared', custom_license: 'Custom license file', bad_expression: 'Invalid SPDX expression', exception_expired: 'Exception expired', exception_unapproved: 'Exception has no approver', license_mismatch: 'Lockfile and package disagree', license_normalized: 'License id normalised', exception_applied: 'Exception applied', project_license_missing: 'Project has no license field', license_file_missing: 'Project has no LICENSE file' };
export function sarif(r, tool) {
  const lines = (r._lockText || '').split('\n');
  const lineOf = (name) => { const i = lines.findIndex((l) => l.includes(`"node_modules/${name}": {`)); return i >= 0 ? i + 1 : 1; };
  const used = [...new Set(r.findings.map((f) => f.check))];
  return { $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0', runs: [{ tool: { driver: { name: tool.name, version: tool.version, informationUri: 'https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/lycurgus-of-licenses', rules: used.map((id) => ({ id, shortDescription: { text: RULES[id] || id } })) } },
    results: r.findings.map((f) => ({ ruleId: f.check, level: f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warning' : 'note', message: { text: `${f.detail}${f.policy_section ? ` (${r.policy_source} ${f.policy_section})` : ''}` }, locations: [{ physicalLocation: { artifactLocation: { uri: r._lockText && !/^project_|^license_file/.test(f.check) ? 'package-lock.json' : 'package.json' }, region: { startLine: f.check.startsWith('project_') || f.check === 'license_file_missing' ? 1 : lineOf(f.package) } } }] })) }] };
}
export function reportMarkdown(r) {
  const L = [`# License policy check: ${r.project.name || 'project'}`, '', `Result: **${r.check}** against ${r.policy_source} (as of ${r.as_of}). ${r.packages.length} package(s): ${DECISIONS.map((d) => `${r.counts[d] || 0} ${d}`).join(', ')}. ${r.skipped.length} skipped.`, '', '## Findings', '', '| Severity | Check | Package | Detail | Policy |', '|---|---|---|---|---|'];
  for (const f of r.findings) L.push(`| ${f.severity} | ${f.check} | ${f.package}${f.version ? '@' + f.version : ''} | ${f.detail.replace(/\|/g, '\\|')} | ${f.policy_section || ''} |`);
  if (!r.findings.length) L.push('| | none | | | |');
  L.push('', '## Packages', '', '| Package | Version | License | Decision | Source |', '|---|---|---|---|---|');
  for (const p of r.packages) L.push(`| ${p.name} | ${p.version || ''} | ${p.license || '(none)'} | ${p.decision}${p.exception ? ' (exception)' : ''} | ${p.license_source} |`);
  if (r.skipped.length) L.push('', '## Skipped', '', ...r.skipped.map((s) => `- ${s.name}: ${s.why}`));
  L.push('', '## Limits', '', r.limits, '');
  return L.join('\n');
}
