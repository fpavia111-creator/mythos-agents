// Lycurgus of Licenses: apply a written license policy to a project's dependencies.
// Reads npm, pnpm, yarn, Python and Go lockfiles plus installed package metadata and
// license files. Writes nothing in the project.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readPnpm, readYarn, readPython, readGo, pyProjectMeta } from './lockfiles.js';
import { identifyLicense, licenseFiles, readText, copyrightLines, normalize } from './license-text.js';

export const LIMITS = 'Lycurgus applies the policy you wrote to the license each package declares in its metadata. Where a package declares none, it compares the package\'s license file with a small set of standard license texts and says how sure it is; anything less than a close match goes to a person. It does not read source files for hidden terms, it does not decide what a license allows, and it is not legal advice. A pass means "matches your policy as written", not "cleared for distribution".';
export const ECOSYSTEMS = ['auto', 'npm', 'pnpm', 'yarn', 'python', 'go'];
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

const hasLicenseFile = (dir) => readdirSync(dir).some((f) => /^(LICEN[CS]E|COPYING)(\.|$)/i.test(f));
const PY_LOCKS = ['poetry.lock', 'uv.lock', 'requirements.txt'];
/** Which lockfile a project folder has. npm first, then pnpm, yarn, Python, Go. */
export function detectEcosystem(projectDir) {
  const has = (f) => existsSync(join(projectDir, f));
  if (has('package-lock.json')) return 'npm';
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (PY_LOCKS.some(has)) return 'python';
  if (has('go.mod')) return 'go';
  if (has('package.json')) return 'npm';
  return null;
}

export function readProject(projectDir, opts = {}) {
  const eco = opts.ecosystem && opts.ecosystem !== 'auto' ? opts.ecosystem : detectEcosystem(projectDir);
  if (!eco) throw new Error('package.json not found in the project folder (and no pnpm-lock.yaml, yarn.lock, poetry.lock, uv.lock, requirements.txt or go.mod)');
  if (!ECOSYSTEMS.includes(eco)) throw new Error(`ecosystem must be one of ${ECOSYSTEMS.join(', ')}`);
  const need = (f, label) => { if (!existsSync(join(projectDir, f))) throw new Error(`${label || f} not found in the project folder`); };
  if (eco === 'python') {
    if (!PY_LOCKS.some((f) => existsSync(join(projectDir, f)))) throw new Error('no poetry.lock, uv.lock or requirements.txt in the project folder');
    const r = readPython(projectDir, opts);
    return { pj: pyProjectMeta(projectDir), ...r, ecosystem: 'python', metaLabel: 'METADATA', hasLicenseFile: hasLicenseFile(projectDir) };
  }
  if (eco === 'go') {
    need('go.mod'); const r = readGo(projectDir);
    return { pj: { name: r.module, version: null, license: null, _noLicenseField: true }, ...r, ecosystem: 'go', metaLabel: 'module metadata', hasLicenseFile: hasLicenseFile(projectDir) };
  }
  need('package.json'); const pj = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
  if (eco === 'pnpm') { need('pnpm-lock.yaml'); return { pj, ...readPnpm(projectDir, pj, opts), ecosystem: 'pnpm', metaLabel: 'package.json', hasLicenseFile: hasLicenseFile(projectDir) }; }
  if (eco === 'yarn') { need('yarn.lock'); return { pj, ...readYarn(projectDir, pj, opts), ecosystem: 'yarn', metaLabel: 'package.json', hasLicenseFile: hasLicenseFile(projectDir) }; }
  const lockf = join(projectDir, 'package-lock.json');
  const pkgs = []; let lockText = null; let lockVersion = null;
  const dirOf = (key) => (existsSync(join(projectDir, key)) ? join(projectDir, key) : null);
  if (existsSync(lockf)) {
    lockText = readFileSync(lockf, 'utf8'); const lock = JSON.parse(lockText); lockVersion = lock.lockfileVersion;
    if (lock.packages) {
      for (const [key, v] of Object.entries(lock.packages)) {
        if (!key || !key.includes('node_modules/')) continue;
        if (v.link) { pkgs.push({ key, name: nameFromKey(key), version: v.version || null, link: true }); continue; }
        pkgs.push({ key, name: nameFromKey(key), version: v.version || null, lock_license: v.license, dev: !!v.dev, optional: !!v.optional, installed_license: installedLicense(projectDir, key), dir: dirOf(key) });
      }
    } else if (lock.dependencies) {
      const walk = (deps, prefix) => { for (const [n, v] of Object.entries(deps)) { const key = `${prefix}node_modules/${n}`; pkgs.push({ key, name: n, version: v.version || null, dev: !!v.dev, installed_license: installedLicense(projectDir, key), dir: dirOf(key) }); if (v.dependencies) walk(v.dependencies, `${key}/`); } };
      walk(lock.dependencies, '');
    }
  } else if (existsSync(join(projectDir, 'node_modules'))) {
    for (const n of readdirSync(join(projectDir, 'node_modules'))) {
      if (n.startsWith('.')) continue;
      const names = n.startsWith('@') ? readdirSync(join(projectDir, 'node_modules', n)).map((x) => `${n}/${x}`) : [n];
      for (const name of names) { const key = `node_modules/${name}`; const f = join(projectDir, key, 'package.json'); if (!existsSync(f)) continue; const p = JSON.parse(readFileSync(f, 'utf8')); pkgs.push({ key, name, version: p.version || null, installed_license: p.license ?? p.licenses ?? null, dir: join(projectDir, key) }); }
    }
  } else throw new Error('no package-lock.json or node_modules in the project folder; run npm install first');
  for (const p of pkgs) if (!p.link) p.ecosystem = 'npm';
  return { pj, pkgs, lockText, lockVersion, lockFile: lockText ? 'package-lock.json' : null, ecosystem: 'npm', metaLabel: 'package.json', hasLicenseFile: hasLicenseFile(projectDir) };
}

/** Identify a package's license from its license file(s). Several files are read as "all apply" (AND). */
export function detectFromFiles(p, named) {
  let files = licenseFiles(p.dir);
  if (named && p.dir) { const f = join(p.dir, named); files = existsSync(f) ? [f] : []; }
  const texts = files.map((f) => ({ file: basename(f), text: readText(f) })).filter((x) => x.text.trim());
  if (!texts.length && p.metadata_text) texts.push({ file: 'METADATA License field', text: p.metadata_text });
  if (!texts.length) return null;
  const parts = texts.map((t) => ({ file: t.file, ...identifyLicense(t.text) }));
  const ids = [...new Set(parts.filter((x) => x.id).map((x) => x.id))];
  const level = parts.some((x) => x.level === 'none') ? 'none' : parts.some((x) => x.level === 'low') ? 'low' : 'high';
  return { id: level === 'none' ? null : ids.join(' AND '), level, confidence: Math.min(...parts.map((x) => x.confidence)), files: parts.map((x) => x.file), method: [...new Set(parts.map((x) => x.method))].join('; '), notes: [...new Set(parts.map((x) => x.note).filter(Boolean))], parts };
}
const sameFamily = (a, b) => String(a).replace(/-(only|or-later)$/i, '').toLowerCase() === String(b).replace(/-(only|or-later)$/i, '').toLowerCase();

function exceptionFor(policy, name, version, asOf) {
  const ex = (policy.exceptions || []).find((e) => e.package === name && (!e.version || e.version === '*' || e.version === version));
  if (!ex) return null;
  if (!String(ex.approved_by || '').trim()) return { ex, state: 'unapproved' };
  if (ex.expires && Date.parse(ex.expires) < asOf) return { ex, state: 'expired' };
  return { ex, state: 'active' };
}

export function check(projectDir, policyIn, { as_of, include_dev, ecosystem, modules_dir, site_packages, detect_text = true } = {}) {
  const policy = validatePolicy(policyIn);
  const asOf = as_of ? Date.parse(as_of) : Date.now();
  if (Number.isNaN(asOf)) throw new Error('as_of must be a date like 2026-11-14');
  const proj = readProject(projectDir, { ecosystem, modules_dir, site_packages });
  const lockName = proj.lockFile || 'the lockfile'; const worse = (a, b) => (RANK[a] >= RANK[b] ? a : b);
  const sec = (k) => policy.sections[k] || null;
  const dev = include_dev ?? policy.dev_dependencies !== 'ignore';
  const packages = []; const findings = []; const skipped = [];
  const add = (f) => findings.push(f);
  for (const p of proj.pkgs) {
    if (p.link) { skipped.push({ name: p.name, why: 'workspace link (your own code)' }); continue; }
    if (p.dev && !dev) { skipped.push({ name: p.name, why: 'dev dependency (policy ignores them)' }); continue; }
    const fromLock = normalizeLicense(p.lock_license); const fromPkg = normalizeLicense(p.installed_license);
    const lic = fromLock.expression ? fromLock : fromPkg;
    if (!fromLock.expression && fromPkg.expression && p.installed_normalized) fromPkg.normalized = true;
    const src = fromLock.expression ? 'package-lock.json' : fromPkg.expression ? `${proj.metaLabel}${p.installed_via ? ` (${p.installed_via})` : ''}` : 'none';
    const row = { name: p.name, version: p.version, key: p.key, dev: !!p.dev, ecosystem: p.ecosystem || 'npm', license: lic.expression, license_source: src, decision: null, why: '', policy_section: null, exception: null, detected: null, _dir: p.dir || null };
    // License files: used when nothing is declared, and to cross-check what is declared.
    const custom = lic.expression ? /^SEE LICEN[CS]E IN (.+)$/i.exec(lic.expression) : null;
    const det = detect_text && p.dir ? detectFromFiles(p, custom ? custom[1].trim() : null) : detect_text && p.metadata_text ? detectFromFiles(p, null) : null;
    if (det) row.detected = { id: det.id, level: det.level, confidence: det.confidence, files: det.files, method: det.method, notes: det.notes };
    let textRule = null; // { level, id } when the decision rests on a license text
    if ((!lic.expression || custom) && det && det.level !== 'none') textRule = det;
    else if (lic.expression && !custom && det && det.level === 'high' && !/\s/.test(lic.expression.replace(/[()]/g, '')) && !sameFamily(det.id, lic.expression) && !det.id.split(' AND ').some((x) => sameFamily(x, lic.expression))) {
      add({ check: 'license_text_mismatch', severity: 'warning', package: p.name, version: p.version, detail: `Metadata says ${lic.expression}, but ${det.files.join(', ')} matches the ${det.id} text (${det.confidence}). The declared license is used for the decision; a person should look.` });
    }
    if (fromLock.expression && fromPkg.expression && fromLock.expression !== fromPkg.expression) add({ check: 'license_mismatch', severity: 'warning', package: p.name, version: p.version, detail: `package-lock.json says ${fromLock.expression}; the installed package.json says ${fromPkg.expression}. The lockfile value is used.` });
    if (lic.normalized) add({ check: 'license_normalized', severity: 'advisory', package: p.name, version: p.version, detail: `Declared as "${lic.raw}"; read as the SPDX id ${lic.expression}.` });
    let res;
    if (textRule) {
      const ev = evaluate(parseExpression(textRule.id), policy); const where = `${textRule.files.join(', ')} ${textRule.level === 'high' ? 'matches' : 'looks like'} the ${textRule.id} text (${textRule.confidence}, ${textRule.method})`;
      if (textRule.level === 'high') {
        row.license = textRule.id; row.license_source = `license text (${textRule.files.join(', ')})`;
        add({ check: 'license_from_text', severity: 'advisory', package: p.name, version: p.version, detail: `No license in the metadata; ${where}.` });
        res = { decision: ev.decision === 'unknown' && policy.unknown === 'deny' ? 'deny' : ev.decision, why: `${ev.why} (read from the license text)`, section: sec(ev.decision), check: { deny: 'denied', review: 'needs_review', unknown: 'unknown_license', allow: null }[ev.decision] };
      } else {
        // Low confidence never allows: at least review, and stricter if the policy says so.
        const d = worse('review', ev.decision === 'unknown' && policy.unknown === 'deny' ? 'deny' : ev.decision);
        res = { decision: d, why: `no license in the metadata; ${where}; low confidence, so a person must confirm${textRule.notes.length ? `. ${textRule.notes.join(' ')}` : ''}`, section: sec(d), check: 'license_text_low_confidence' };
      }
    } else if (!lic.expression) res = { decision: policy.unknown === 'deny' ? 'deny' : 'unknown', why: `no license declared${det ? `, and ${det.files.join(', ')} does not match a known license text` : ''}`, section: sec('unknown'), check: 'no_license' };
    else if (custom) res = { decision: policy.unknown === 'deny' ? 'deny' : 'unknown', why: `custom license file (${lic.expression}); a person must read it${det ? '; it does not match a known license text' : ''}`, section: sec('unknown'), check: 'custom_license' };
    else {
      let tree; try { tree = parseExpression(lic.expression); } catch (e) { tree = null; res = { decision: policy.unknown === 'deny' ? 'deny' : 'unknown', why: `not a valid SPDX expression (${e.message})`, section: sec('unknown'), check: 'bad_expression' }; }
      if (tree) { const ev = evaluate(tree, policy); res = { decision: ev.decision === 'unknown' && policy.unknown === 'deny' ? 'deny' : ev.decision, why: ev.why, section: sec(ev.decision), check: { deny: 'denied', review: 'needs_review', unknown: 'unknown_license', allow: null }[ev.decision] }; }
    }
    const exc = res.decision !== 'allow' ? exceptionFor(policy, p.name, p.version, asOf) : null;
    if (exc?.state === 'active') { row.exception = { reason: exc.ex.reason || '', approved_by: exc.ex.approved_by, expires: exc.ex.expires || null }; add({ check: 'exception_applied', severity: 'advisory', package: p.name, version: p.version, detail: `${res.why}; allowed by the exception approved by ${exc.ex.approved_by}${exc.ex.expires ? ` until ${exc.ex.expires}` : ''}.`, policy_section: sec('exceptions') }); res = { ...res, decision: 'allow', check: null };
    } else if (exc) add({ check: exc.state === 'expired' ? 'exception_expired' : 'exception_unapproved', severity: 'warning', package: p.name, version: p.version, detail: exc.state === 'expired' ? `The exception expired on ${exc.ex.expires}, so it no longer applies.` : 'The exception has no approved_by, so it does not apply.', policy_section: sec('exceptions') });
    row.decision = res.decision; row.why = res.why; row.policy_section = res.section;
    if (res.check) add({ check: res.check, severity: res.decision === 'deny' ? 'error' : 'warning', package: p.name, version: p.version, detail: `${p.name}@${p.version} (${row.license || lic.expression || 'none'}): ${res.why}.`, policy_section: res.section });
    packages.push(row);
  }
  // Exception hygiene: nothing to apply to, or about to run out.
  for (const ex of policy.exceptions || []) {
    const used = proj.pkgs.some((p) => !p.link && p.name === ex.package && (!ex.version || ex.version === '*' || ex.version === p.version));
    if (!used) add({ check: 'exception_unused', severity: 'advisory', package: ex.package, version: ex.version || null, detail: `The policy has an exception for ${ex.package}${ex.version ? `@${ex.version}` : ''}, but that package is not in ${lockName}. Remove the exception or check the version.`, policy_section: sec('exceptions') });
    const exp = ex.expires ? Date.parse(ex.expires) : NaN; const left = Math.ceil((exp - asOf) / 864e5);
    if (used && String(ex.approved_by || '').trim() && left >= 0 && left <= 30) add({ check: 'exception_expiring', severity: 'advisory', package: ex.package, version: ex.version || null, detail: `The exception approved by ${ex.approved_by} expires on ${ex.expires} (${left} day(s) from ${new Date(asOf).toISOString().slice(0, 10)}).`, policy_section: sec('exceptions') });
  }
  if (!proj.pj.license && !proj.pj._noLicenseField) add({ check: 'project_license_missing', severity: 'warning', package: proj.pj.name || '(project)', version: proj.pj.version || null, detail: `Your ${proj.ecosystem === 'python' ? 'pyproject.toml' : 'package.json'} has no license field.` });
  if (!proj.hasLicenseFile) add({ check: 'license_file_missing', severity: 'warning', package: proj.pj.name || '(project)', version: proj.pj.version || null, detail: 'No LICENSE, LICENCE or COPYING file in the project folder.' });
  const counts = {}; for (const p of packages) counts[p.decision] = (counts[p.decision] || 0) + 1;
  const result = counts.deny ? 'fail' : counts.review || counts.unknown ? 'pass_with_review' : 'pass';
  const sev = { error: 0, warning: 1, advisory: 2 };
  findings.sort((a, b) => sev[a.severity] - sev[b.severity]);
  return { project: { name: proj.pj.name || null, version: proj.pj.version || null, license: proj.pj.license || null }, policy_source: policy.source, ecosystem: proj.ecosystem, lockfile: proj.lockFile, lockfile_version: proj.lockVersion, include_dev: dev, as_of: new Date(asOf).toISOString().slice(0, 10), check: result, counts, packages, skipped, findings, issues: findings.filter((f) => f.severity !== 'advisory').length, limits: LIMITS, _lockText: proj.lockText };
}

export const purl = (n, v, eco = 'npm') => (eco === 'pypi' ? `pkg:pypi/${String(n).toLowerCase().replace(/[-_.]+/g, '-')}${v ? '@' + v : ''}` : eco === 'golang' ? `pkg:golang/${n}${v ? '@' + v : ''}` : `pkg:npm/${n.startsWith('@') ? '%40' + n.slice(1) : n}${v ? '@' + v : ''}`);
export function sbom(r, tool) {
  return {
    bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    metadata: { timestamp: new Date().toISOString(), tools: { components: [{ type: 'application', name: tool.name, version: tool.version }] }, component: { type: 'application', name: r.project.name || 'project', version: r.project.version || '0.0.0', ...(r.project.license ? { licenses: [{ expression: r.project.license }] } : {}) } },
    components: r.packages.map((p) => ({ type: 'library', 'bom-ref': purl(p.name, p.version, p.ecosystem), name: p.name, version: p.version || '', purl: purl(p.name, p.version, p.ecosystem), scope: p.dev ? 'excluded' : 'required', ...(p.license ? { licenses: [{ expression: p.license }] } : {}) })),
  };
}
const RULES = { denied: 'License is on the deny list', needs_review: 'License needs review under the policy', unknown_license: 'License is not covered by the policy', no_license: 'No license declared', custom_license: 'Custom license file', bad_expression: 'Invalid SPDX expression', exception_expired: 'Exception expired', exception_unapproved: 'Exception has no approver', license_mismatch: 'Lockfile and package disagree', license_normalized: 'License id normalised', exception_applied: 'Exception applied', license_from_text: 'License read from the license text', license_text_low_confidence: 'License text matched with low confidence', license_text_mismatch: 'License text differs from the declared license', exception_unused: 'Exception for a package that is not in the project', exception_expiring: 'Exception expires soon', project_license_missing: 'Project has no license field', license_file_missing: 'Project has no LICENSE file' };
export function sarif(r, tool) {
  const lines = (r._lockText || '').split('\n');
  const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lineOf = (name) => {
    const n = esc(name); const res = [new RegExp(`"node_modules/${n}": \\{`), new RegExp(`^\\s*'?/?${n}@`), new RegExp(`^"?${n}@`), new RegExp(`^name = "${n}"`), new RegExp(`^# ${n} `), new RegExp(`^\\s*${n} v`), new RegExp(`^${n}==`, 'i')];
    for (const re of res) { const i = lines.findIndex((l) => re.test(l)); if (i >= 0) return i + 1; } return 1;
  };
  const manifestFile = r.ecosystem === 'python' ? 'pyproject.toml' : r.ecosystem === 'go' ? 'go.mod' : 'package.json';
  const used = [...new Set(r.findings.map((f) => f.check))];
  return { $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0', runs: [{ tool: { driver: { name: tool.name, version: tool.version, informationUri: 'https://github.com/fpavia111-creator/mythos-agents/tree/main/packages/lycurgus-of-licenses', rules: used.map((id) => ({ id, shortDescription: { text: RULES[id] || id } })) } },
    results: r.findings.map((f) => ({ ruleId: f.check, level: f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warning' : 'note', message: { text: `${f.detail}${f.policy_section ? ` (${r.policy_source} ${f.policy_section})` : ''}` }, locations: [{ physicalLocation: { artifactLocation: { uri: r._lockText && !/^project_|^license_file/.test(f.check) ? (r.lockfile || 'package-lock.json') : manifestFile }, region: { startLine: f.check.startsWith('project_') || f.check === 'license_file_missing' ? 1 : lineOf(f.package) } } }] })) }] };
}
export function reportMarkdown(r) {
  const L = [`# License policy check: ${r.project.name || 'project'}`, '', `Result: **${r.check}** against ${r.policy_source} (as of ${r.as_of}), read from ${r.lockfile || 'installed packages'} (${r.ecosystem}). ${r.packages.length} package(s): ${DECISIONS.map((d) => `${r.counts[d] || 0} ${d}`).join(', ')}. ${r.skipped.length} skipped.`, '', '## Findings', '', '| Severity | Check | Package | Detail | Policy |', '|---|---|---|---|---|'];
  for (const f of r.findings) L.push(`| ${f.severity} | ${f.check} | ${f.package}${f.version ? '@' + f.version : ''} | ${f.detail.replace(/\|/g, '\\|')} | ${f.policy_section || ''} |`);
  if (!r.findings.length) L.push('| | none | | | |');
  L.push('', '## Packages', '', '| Package | Version | License | Decision | Source | License file match |', '|---|---|---|---|---|---|');
  for (const p of r.packages) L.push(`| ${p.name} | ${p.version || ''} | ${p.license || '(none)'} | ${p.decision}${p.exception ? ' (exception)' : ''} | ${p.license_source} | ${p.detected ? `${p.detected.id || 'not identified'} (${p.detected.level}${p.detected.id ? `, ${p.detected.confidence}` : ''}; ${p.detected.files.join(', ')})` : ''} |`);
  if (r.skipped.length) L.push('', '## Skipped', '', ...r.skipped.map((s) => `- ${s.name}: ${s.why}`));
  L.push('', '## Limits', '', r.limits, '');
  return L.join('\n');
}

// ---------- 0.2.0: third-party notices ----------
export const NO_ATTRIBUTION_DEFAULT = ['0BSD', 'Unlicense', 'CC0-1.0', 'WTFPL', 'LicenseRef-Public-Domain', 'UNLICENSED'];
const leafIds = (expr) => { try { const out = []; const walk = (t) => (t.id ? out.push(t.id) : t.args.forEach(walk)); walk(parseExpression(expr)); return out; } catch { return [expr]; } };
/**
 * Build an attribution file for shipped (non-dev) dependencies the policy lets through.
 * A package is left out only when every license it carries is on the policy's
 * attribution.not_required list (default: public-domain-style licenses and UNLICENSED).
 * License texts and copyright lines come from installed license files; when a package is
 * not installed locally the entry carries a [TO ADD] marker instead of a guessed text.
 */
export function notices(r, policyIn, tool = {}) {
  const policy = validatePolicy(policyIn); const notReq = policy.attribution?.not_required || NO_ATTRIBUTION_DEFAULT;
  const entries = []; const left_out = []; const needs_person = []; const texts = new Map();
  for (const p of r.packages.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    const id = `${p.name}@${p.version || '?'}`;
    if (p.dev) { left_out.push({ package: id, why: 'dev dependency (not shipped)' }); continue; }
    if (p.decision === 'deny') { left_out.push({ package: id, why: `denied by the policy (${p.license || 'no license'}); replace or remove it` }); continue; }
    if (!p.license || /^SEE LICEN[CS]E IN /i.test(p.license)) { needs_person.push(`${id}: license not identified (${p.why}); decide whether and how to attribute it.`); continue; }
    if (leafIds(p.license).every((x) => listHas(notReq, x))) { left_out.push({ package: id, why: `${p.license} is on the policy's attribution.not_required list` }); continue; }
    const files = licenseFiles(p._dir).map((f) => ({ file: basename(f), text: readText(f).replace(/\r\n/g, '\n').trim() })).filter((x) => x.text);
    const noticeFile = p._dir ? readdirSync(p._dir).filter((f) => /^notice(\.|$)/i.test(f)).sort()[0] : null;
    const noticeText = noticeFile ? readText(join(p._dir, noticeFile)).replace(/\r\n/g, '\n').trim() : '';
    const e = { name: p.name, version: p.version, license: p.license, decision: p.decision, exception: !!p.exception, copyright: copyrightLines(files.map((x) => x.text).concat(noticeText).join('\n')), text_refs: [], license_files: files.map((x) => x.file), notice_file: noticeFile, notice_text: noticeText, missing_text: !files.length };
    for (const f of files) { const k = normalize(f.text); if (!texts.has(k)) { const det = identifyLicense(f.text); texts.set(k, { ref: `T${texts.size + 1}`, text: f.text.split('\n').filter((l) => !copyrightLines(l).length).join('\n').replace(/\n{3,}/g, '\n\n').trim(), license: det.level === 'high' ? det.id : det.id ? `looks like ${det.id} (not a close match)` : `text of ${f.file} (not a standard text Lycurgus knows)`, used_by: [] }); } const t = texts.get(k); t.used_by.push(id); e.text_refs.push(t.ref); }
    if (e.missing_text) needs_person.push(`${id} (${p.license}): no license file found locally; add its license text and copyright notice.`);
    else if (!e.copyright.length) needs_person.push(`${id} (${p.license}): no copyright line found in ${e.license_files.join(', ')}; check the package for one.`);
    if (r.findings.some((x) => x.check === 'license_text_mismatch' && x.package === p.name)) needs_person.push(`${id}: metadata says ${p.license}, but its license file matches ${p.detected?.id}; check which one applies.`);
    if (p.decision !== 'allow') needs_person.push(`${id} (${p.license}): the policy says ${p.decision}; confirm it may ship before relying on this file.`);
    entries.push(e);
  }
  const L = [`# Third-party notices${r.project.name ? ` for ${r.project.name}${r.project.version ? ` ${r.project.version}` : ''}` : ''}`, '', `Draft generated by ${tool.name || 'lycurgus-of-licenses'}${tool.version ? ` ${tool.version}` : ''} from ${r.lockfile || 'installed packages'} against ${r.policy_source} (as of ${r.as_of}). ${entries.length} package(s).`, '', '> A starting point for a person to review. It lists what the package metadata and license files say; it is not legal advice and does not decide what any license requires.', '', '## Packages', ''];
  for (const e of entries) {
    L.push(`### ${e.name}${e.version ? ` ${e.version}` : ''}`, '', `License: ${e.license}${e.decision !== 'allow' ? ` (policy: ${e.decision})` : e.exception ? ' (allowed by exception)' : ''}`);
    for (const c of e.copyright) L.push(c);
    L.push(e.missing_text ? `License text: [TO ADD: license text and copyright notice for ${e.name}; no license file was found locally]` : `License text: ${e.text_refs.map((x) => `[${x}]`).join(', ')} (${e.license_files.join(', ')})`);
    if (e.notice_text) L.push('', `${e.notice_file}:`, '', ...e.notice_text.split('\n').map((l) => `    ${l}`));
    L.push('');
  }
  if (!entries.length) L.push('None.', '');
  L.push('## License texts', '');
  for (const t of texts.values()) L.push(`### [${t.ref}] ${t.license}`, '', `Used by: ${t.used_by.join(', ')}`, '', ...t.text.split('\n').map((l) => `    ${l}`), '');
  if (!texts.size) L.push('None found locally.', '');
  L.push(`## Left out (${left_out.length})`, '', ...(left_out.length ? left_out.map((x) => `- ${x.package}: ${x.why}`) : ['- none']), '', `## Needs a person (${needs_person.length})`, '', ...(needs_person.length ? needs_person.map((x) => `- [ ] ${x}`) : ['- none']), '');
  return { text: L.join('\n'), entries, left_out, needs_person, missing_texts: entries.filter((e) => e.missing_text).length, license_texts: texts.size };
}

// ---------- 0.2.0: what changed since a baseline SBOM ----------
const bomLicense = (c) => (c.licenses || []).map((l) => l.expression || l.license?.id || l.license?.name).filter(Boolean).join(' AND ') || null;
/** Compare an earlier CycloneDX SBOM (from lycurgus_write_report or another tool) with the current check. */
export function diffSbom(prevBom, r) {
  if (!prevBom || !Array.isArray(prevBom.components)) throw new Error('baseline must be a CycloneDX SBOM with a components array (for example an earlier sbom.cdx.json)');
  const prev = new Map(prevBom.components.map((c) => [c.name, { version: c.version || null, license: bomLicense(c) }]));
  const cur = new Map(r.packages.map((p) => [p.name, p]));
  const d = { baseline: { name: prevBom.metadata?.component?.name || null, version: prevBom.metadata?.component?.version || null }, added: [], removed: [], version_changed: [], license_changed: [], new_problems: [] };
  for (const [name, p] of cur) {
    const b = prev.get(name); const row = { name, version: p.version, license: p.license, decision: p.decision };
    if (!b) { d.added.push(row); if (p.decision !== 'allow') d.new_problems.push({ ...row, why: `new dependency: ${p.why}` }); continue; }
    if (b.version !== (p.version || null) && b.version !== (p.version || '')) d.version_changed.push({ name, from: b.version, to: p.version });
    if ((b.license || null) !== (p.license || null)) { d.license_changed.push({ name, from: b.license, to: p.license, version_from: b.version, version_to: p.version, decision: p.decision }); if (p.decision !== 'allow') d.new_problems.push({ ...row, why: `license changed from ${b.license || 'none'} to ${p.license || 'none'}: ${p.why}` }); }
  }
  for (const [name, b] of prev) if (!cur.has(name)) d.removed.push({ name, version: b.version, license: b.license });
  d.changes = d.added.length + d.removed.length + d.version_changed.length + d.license_changed.length;
  return d;
}
export function diffMarkdown(d, r) {
  const L = [`# Dependency license changes: ${r.project.name || 'project'}`, '', `Since the baseline${d.baseline.version ? ` (${d.baseline.name || ''} ${d.baseline.version})` : ''}: ${d.added.length} added, ${d.removed.length} removed, ${d.version_changed.length} version change(s), ${d.license_changed.length} license change(s); ${d.new_problems.length} need a look under ${r.policy_source}.`, ''];
  const sec = (t, arr, f) => L.push(`## ${t} (${arr.length})`, '', ...(arr.length ? arr.map((x) => `- ${f(x)}`) : ['- none']), '');
  sec('Needs a look', d.new_problems, (x) => `**${x.decision}** ${x.name}@${x.version} (${x.license || 'no license'}): ${x.why}`);
  sec('License changed', d.license_changed, (x) => `${x.name}: ${x.from || 'none'} (${x.version_from}) → ${x.to || 'none'} (${x.version_to}), now ${x.decision}`);
  sec('Added', d.added, (x) => `${x.name}@${x.version} (${x.license || 'no license'}): ${x.decision}`);
  sec('Removed', d.removed, (x) => `${x.name}@${x.version}`);
  sec('Version changed', d.version_changed, (x) => `${x.name}: ${x.from} → ${x.to}`);
  L.push('Applies your policy as written. Not legal advice.', '');
  return L.join('\n');
}
/** Calendar events for approved exceptions with an expiry date. */
export function exceptionEvents(policyIn) {
  return (validatePolicy(policyIn).exceptions || []).filter((e) => String(e.approved_by || '').trim() && /^\d{4}-\d{2}-\d{2}/.test(String(e.expires || ''))).map((e) => ({ uid: `exception-${e.package.replace(/[^A-Za-z0-9]+/g, '-')}-${e.expires}@lycurgus.local`, date: e.expires, summary: `License exception for ${e.package} expires`, description: `Approved by ${e.approved_by}. ${e.reason || ''}`.trim(), reminders: [30, 7], categories: ['License exception'] }));
}
