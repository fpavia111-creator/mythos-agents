#!/usr/bin/env node
// Pre-publish checklist for every package in this repo, run as a dry run.
// It never publishes, never logs in, never reads or prints NPM_TOKEN, and changes
// nothing outside mythos-out/release-check/ (the report it writes).
//
//   node scripts/release-check.mjs              all checks (tests, evals, hostile data pass, pack, scans, npm names)
//   node scripts/release-check.mjs --offline    skip the npm registry lookups (reported as skipped, not passed)
//   node scripts/release-check.mjs --quick      skip tests, evals and the hostile run (metadata, pack and scans only)
//   node scripts/release-check.mjs --full       also the hostile argument pass (minutes)
//   node scripts/release-check.mjs --json       print the report as JSON
//
// Exit code 0 only when nothing failed. "warn" lines do not fail the run but are listed.
// The manual steps (website backup, Pages deployment id, tests on Windows and on each
// Node version) are printed at the end; this script cannot do them for you.

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PK = join(ROOT, 'packages');
const argv = new Set(process.argv.slice(2));
const OFFLINE = argv.has('--offline'), QUICK = argv.has('--quick'), FULL = argv.has('--full'), JSON_OUT = argv.has('--json');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// Child processes never see a token, even if the shell has one.
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/TOKEN|_AUTH|PASSWORD|SECRET/i.test(k)));
const run = (cmd, args, opts = {}) => { const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', env: childEnv, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 15 * 60 * 1000, shell: process.platform === 'win32' && cmd === NPM, ...opts }); return { code: r.status ?? (r.error ? -1 : 0), out: (r.stdout || '') + (r.stderr || ''), error: r.error }; };

const checks = [];
const add = (area, status, message, detail = null) => { checks.push({ area, status, message, ...(detail ? { detail } : {}) }); if (!JSON_OUT) process.stderr.write(`${status === 'pass' ? 'ok  ' : status === 'fail' ? 'FAIL' : status === 'warn' ? 'warn' : 'skip'}  ${area}: ${message}\n`); };

// ---------- packages and metadata ----------
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const dirs = rootPkg.workspaces.map((w) => join(ROOT, w));
const pkgs = dirs.map((d) => ({ dir: d, rel: relative(ROOT, d).split('\\').join('/'), json: JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')) }));
const core = pkgs.find((p) => p.json.name === 'mythos-agent-core');
const onDisk = readdirSync(PK).filter((n) => existsSync(join(PK, n, 'package.json')));
const missingWs = onDisk.filter((n) => !pkgs.some((p) => p.rel === `packages/${n}`));
missingWs.length ? add('workspaces', 'fail', `packages not listed in the root workspaces: ${missingWs.join(', ')}`) : add('workspaces', 'pass', `${pkgs.length} packages, all listed`);

const metaProblems = [];
for (const p of pkgs) {
  const j = p.json; const n = j.name;
  if (!/^\d+\.\d+\.\d+$/.test(j.version || '')) metaProblems.push(`${n}: version "${j.version}" is not x.y.z`);
  if (j.private) metaProblems.push(`${n}: marked private`);
  if (j.license !== 'MIT') metaProblems.push(`${n}: license is "${j.license}", expected MIT`);
  for (const f of ['README.md', 'LICENSE', 'CHANGELOG.md']) if (!existsSync(join(p.dir, f)) && !(f === 'CHANGELOG.md' && n === 'mythos-agent-core' && existsSync(join(p.dir, 'CHANGELOG.md')))) if (!existsSync(join(p.dir, f))) metaProblems.push(`${n}: no ${f}`);
  if (existsSync(join(p.dir, 'CHANGELOG.md')) && !readFileSync(join(p.dir, 'CHANGELOG.md'), 'utf8').includes(`## ${j.version}`)) metaProblems.push(`${n}: CHANGELOG.md has no "## ${j.version}" section`);
  if (!j.files || !j.files.length) metaProblems.push(`${n}: no "files" list (the whole folder would be published)`);
  if (!j.engines || !/>=\s*20/.test(j.engines.node || '')) metaProblems.push(`${n}: engines.node should be ">=20"`);
  const dep = (j.dependencies || {})['mythos-agent-core'];
  if (n !== 'mythos-agent-core') {
    if (!dep) metaProblems.push(`${n}: does not depend on mythos-agent-core`);
    else if (dep !== `^${core.json.version}`) metaProblems.push(`${n}: depends on mythos-agent-core ${dep}, core is ${core.json.version}`);
  }
  for (const [k, v] of Object.entries({ ...(j.dependencies || {}), ...(j.devDependencies || {}) })) if (/^(file:|link:|workspace:|git|https?:)/.test(String(v))) metaProblems.push(`${n}: dependency ${k} points at "${v}"`);
  for (const [b, f] of Object.entries(j.bin || {})) if (!existsSync(join(p.dir, f))) metaProblems.push(`${n}: bin ${b} -> ${f} does not exist`); else if (!readFileSync(join(p.dir, f), 'utf8').startsWith('#!/usr/bin/env node')) metaProblems.push(`${n}: bin ${f} has no "#!/usr/bin/env node" line`);
}
metaProblems.length ? add('package metadata', 'fail', `${metaProblems.length} problem(s)`, metaProblems) : add('package metadata', 'pass', 'versions, licence, README, LICENSE, CHANGELOG section, files list, engines, core dependency and bins all in order');

// ---------- git state ----------
const git = run('git', ['status', '--porcelain']);
if (git.code !== 0) add('git', 'warn', 'not a git checkout, or git is not installed');
else if (git.out.trim()) add('git', 'warn', `${git.out.trim().split('\n').length} uncommitted change(s): publish from a clean, committed tree`, git.out.trim().split('\n').slice(0, 20));
else add('git', 'pass', 'working tree clean');
const tracked = run('git', ['ls-files']).out.split('\n').filter(Boolean);
const npmrc = tracked.filter((f) => /(^|\/)\.npmrc$/.test(f));
npmrc.length ? add('.npmrc', 'fail', `.npmrc is committed: ${npmrc.join(', ')}`) : add('.npmrc', 'pass', 'no .npmrc in the repository');

// ---------- secret scan (repository files and everything that would be packed) ----------
const SECRET = [
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED |DSA )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{40,}/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['npm auth line', /_authToken\s*=\s*(?!\$\{)[^\s'"`]{8,}/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  // AWS's own documentation example (AKIAIOSFODNN7EXAMPLE) is used as a planted fake in fixtures.
  ['AWS access key id', /\b(?:AKIA|ASIA)(?![A-Z0-9]*EXAMPLE\b)[A-Z0-9]{16}\b/],
  ['Stripe live key', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['licence signing key file', /^-----BEGIN PRIVATE KEY-----/m],
];
const secretHits = [];
for (const f of tracked) {
  const abs = join(ROOT, f); let st; try { st = statSync(abs); } catch { continue; }
  if (!st.isFile() || st.size > 5 * 1024 * 1024) continue;
  const buf = readFileSync(abs); if (buf.includes(0)) continue;
  const txt = buf.toString('utf8');
  for (const [label, re] of SECRET) if (re.test(txt)) secretHits.push(`${f}: ${label}`);
}
secretHits.length ? add('secret scan', 'fail', `${secretHits.length} possible secret(s) in tracked files`, secretHits) : add('secret scan', 'pass', `${tracked.length} tracked files, no keys or tokens found`);

// ---------- copy that must stay honest ----------
// A banned phrase counts only when the sentence does not negate it ("does not make you compliant" is fine).
const BANNED = [/complete ERP/i, /makes? (?:you|your \w+) compliant/i, /\bcertified\b/i, /fully autonomous/i, /cleared for distribution/i, /guarantee[sd]? (?:compliance|accuracy|that)/i, /\b(?:GDPR|CCPA|SOC ?2|HIPAA)[- ]compliant\b/i, /\blegal advice\b/i, /replaces? (?:a |your )?lawyer/i];
const NEG = /\b(?:not|no|never|nor|without|isn't|doesn't|does not|do not|cannot|can't|won't|is not|are not|none)\b/i;
const claimFiles = [join(ROOT, 'README.md'), ...pkgs.flatMap((p) => [join(p.dir, 'README.md'), join(p.dir, 'package.json'), join(p.dir, 'src', 'manifest.js')])].filter(existsSync);
const claimHits = [];
for (const f of claimFiles) {
  const txt = readFileSync(f, 'utf8');
  for (const sentence of txt.split(/(?<=[.!?])\s+|\n{2,}|\n[-*] /)) for (const re of BANNED) if (re.test(sentence) && !NEG.test(sentence)) claimHits.push(`${relative(ROOT, f)}: "${sentence.trim().replace(/\s+/g, ' ').slice(0, 140)}"`);
}
claimHits.length ? add('honest copy', 'fail', `${claimHits.length} sentence(s) make a claim the rules forbid`, claimHits) : add('honest copy', 'pass', `no compliance, certification or autonomy claims in ${claimFiles.length} README/package/manifest files`);

// ---------- policy guard rails ----------
const corePath = join(core.dir, 'src', 'index.js');
const { ONE_CLICK_CATEGORIES } = await import(new URL(`file://${corePath.split('\\').join('/')}`));
const EXPECTED = ['go_live', 'revoke_access', 'delete_personal_data', 'move_money', 'binding_send', 'production_deploy', 'accept_learning'];
const missingCat = EXPECTED.filter((c) => !ONE_CLICK_CATEGORIES.includes(c));
missingCat.length ? add('one-click categories', 'fail', `missing from ONE_CLICK_CATEGORIES: ${missingCat.join(', ')}`) : add('one-click categories', 'pass', `${ONE_CLICK_CATEGORIES.length} categories, all ${EXPECTED.length} required ones present`);
const paid = []; const allowAction = [];
for (const p of pkgs.filter((x) => x !== core)) {
  const { manifest } = await import(new URL(`file://${join(p.dir, 'src', 'index.js').split('\\').join('/')}`));
  for (const t of manifest.tools) { if (t.tier === 'pro') paid.push(`${p.json.name}:${t.name}`); }
  const rules = manifest.policy?.rules || [];
  for (const t of manifest.tools) if (EXPECTED.includes(t.category)) { const r = rules.find((x) => (x.tool === t.name || x.category === t.category)); if (r && r.decision === 'allow') allowAction.push(`${p.json.name}:${t.name}`); }
}
allowAction.length ? add('one-click policy', 'fail', 'one-click tools set to allow', allowAction) : add('one-click policy', 'pass', 'no one-click tool is set to allow');
add('paid tier', paid.length ? 'warn' : 'pass', paid.length ? `${paid.length} tool(s) marked paid: make sure the trusted licence key is in license-keys.js` : 'no tool is marked paid', paid.length ? paid : null);
const { LICENSE_PUBLIC_KEYS } = await import(new URL(`file://${corePath.split('\\').join('/')}`));
if (paid.length && !LICENSE_PUBLIC_KEYS.length) add('licence keys', 'fail', 'tools are marked paid but LICENSE_PUBLIC_KEYS is empty, so nobody could unlock them');

// ---------- tests, evals, hostile ----------
if (QUICK) add('tests', 'skip', 'skipped (--quick)');
else {
  let pass = 0, fail = 0; const failed = [];
  for (const p of pkgs) { const r = run(process.execPath, ['scripts/run-tests.cjs'], { cwd: p.dir }); const pa = +((/^(?:#|ℹ) pass (\d+)/m.exec(r.out) || [])[1] || 0), fa = +((/^(?:#|ℹ) fail (\d+)/m.exec(r.out) || [])[1] || 0); pass += pa; fail += fa; if (r.code !== 0 || fa || !pa) failed.push(`${p.json.name}: ${fa} failing${pa ? '' : ' (no test count found in the output)'}`); }
  failed.length ? add('tests', 'fail', `${pass} passed, ${fail} failed on Node ${process.version}`, failed) : add('tests', 'pass', `${pass} passed on Node ${process.version}`);
  let ep = 0, et = 0; const efail = [];
  for (const p of pkgs.filter((x) => x !== core)) { const r = run(process.execPath, [`bin/${p.json.name}.js`, 'eval'], { cwd: p.dir }); const m = /(\d+)\/(\d+)\s*$/.exec(r.out.trim().split('\n').pop() || '') || /(\d+)\/(\d+)/.exec(r.out.trim().split('\n').pop() || ''); if (!m) { efail.push(`${p.json.name}: no eval result`); continue; } ep += +m[1]; et += +m[2]; if (m[1] !== m[2] || r.code !== 0) efail.push(`${p.json.name}: ${m[1]}/${m[2]}`); }
  efail.length ? add('evals', 'fail', `${ep}/${et}`, efail) : add('evals', 'pass', `${ep}/${et}`);
  const h = run(process.execPath, ['scripts/hostile-inputs.mjs', ...(FULL ? ['--args'] : [])], { timeout: 60 * 60 * 1000 });
  const hl = (/(\d+) finding\(s\)/.exec(h.out) || [])[1];
  h.code === 0 ? add('hostile inputs', 'pass', `0 findings${FULL ? ' (data, exports and argument passes)' : ' (data and export passes; add --full for the argument pass)'}`) : add('hostile inputs', 'fail', `${hl ?? '?'} finding(s)`, h.out.split('\n').filter((l) => /^\s{2}\S|^[A-Z_]+ \(/.test(l)).slice(0, 30));
}

// ---------- pack contents ----------
const packProblems = []; const packs = [];
for (const p of pkgs) {
  const r = run(NPM, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: p.dir });
  let info; try { info = JSON.parse(r.out.slice(r.out.indexOf('['))); } catch { packProblems.push(`${p.json.name}: npm pack --dry-run failed: ${r.out.trim().split('\n').pop()}`); continue; }
  const files = info[0].files.map((f) => f.path);
  const bad = files.filter((f) => /(^|\/)(node_modules|\.mythos|mythos-out|test|\.github)\/|\.npmrc$|\.tgz$|(^|\/)\.env/.test(f) || (/\.(pem|key)$/.test(f) && /PRIVATE KEY/.test(readFileSync(join(p.dir, f), 'utf8'))));
  if (bad.length) packProblems.push(`${p.json.name}: would publish ${bad.slice(0, 5).join(', ')}`);
  for (const need of ['package.json', 'README.md', 'LICENSE']) if (!files.includes(need)) packProblems.push(`${p.json.name}: ${need} is not in the package`);
  for (const f of files) { const abs = join(p.dir, f); if (!existsSync(abs)) continue; const txt = readFileSync(abs).toString('utf8'); for (const [label, re] of SECRET) if (re.test(txt)) packProblems.push(`${p.json.name}: ${f} looks like it holds a ${label}`); }
  packs.push({ name: p.json.name, version: p.json.version, files: files.length, size_kb: Math.round(info[0].size / 1024), unpacked_kb: Math.round(info[0].unpackedSize / 1024) });
}
packProblems.length ? add('pack contents', 'fail', `${packProblems.length} problem(s)`, packProblems) : add('pack contents', 'pass', `${packs.length} packages; ${packs.reduce((t, x) => t + x.size_kb, 0)} KB packed in total; no tests, state, output, keys or .npmrc`);

// ---------- npm registry: names and versions ----------
const registry = [];
if (OFFLINE) add('npm names', 'skip', 'skipped (--offline): name and version checks were NOT done');
else {
  let unreachable = 0; const clash = []; const free = []; const taken = [];
  for (const p of pkgs) {
    const r = run(NPM, ['view', p.json.name, 'versions', 'maintainers', '--json'], { timeout: 60000 });
    if (/E404|404 Not Found/.test(r.out)) { free.push(p.json.name); registry.push({ name: p.json.name, published: null }); continue; }
    let d; try { d = JSON.parse(r.out); } catch { unreachable++; registry.push({ name: p.json.name, published: 'unknown' }); continue; }
    const versions = [].concat(d.versions || []); const maint = [].concat(d.maintainers || []).map((m) => String(m).split(' ')[0]);
    registry.push({ name: p.json.name, published: versions, maintainers: maint });
    if (versions.includes(p.json.version)) clash.push(`${p.json.name}@${p.json.version} is already published: bump the version`);
    else if (versions.some((v) => cmp(v, p.json.version) > 0)) clash.push(`${p.json.name}: ${p.json.version} is lower than published ${versions.filter((v) => cmp(v, p.json.version) > 0).pop()}`);
    taken.push(`${p.json.name} (maintainers: ${maint.join(', ') || 'unknown'}; latest ${versions[versions.length - 1] || 'none'})`);
  }
  if (unreachable === pkgs.length) add('npm names', 'warn', 'the npm registry could not be reached: name and version checks were NOT done (run again online, or with --offline to say so on purpose)');
  else {
    if (unreachable) add('npm names', 'warn', `${unreachable} package(s) could not be looked up`);
    clash.length ? add('npm versions', 'fail', `${clash.length} version clash(es)`, clash) : add('npm versions', 'pass', 'no version is already published or lower than a published one');
    add('npm names', 'pass', `${free.length} name(s) free, ${taken.length} already on npm (check the maintainers are you)`, [...free.map((n) => `${n}: free`), ...taken]);
  }
}
function cmp(a, b) { const x = a.split(/[.-]/).map(Number), y = b.split(/[.-]/).map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; }

// ---------- report ----------
const failed = checks.filter((c) => c.status === 'fail'); const warned = checks.filter((c) => c.status === 'warn'); const skipped = checks.filter((c) => c.status === 'skip');
const order = [core, ...pkgs.filter((p) => p !== core)];
const publish = [
  '# Run these yourself, only after reading this report. NPM_TOKEN comes from your environment;',
  '# npm expands ${NPM_TOKEN} itself, so the token is never written to disk in clear or printed.',
  'export NPM_CONFIG_USERCONFIG="$(mktemp)"',
  "printf '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\\n' > \"$NPM_CONFIG_USERCONFIG\"",
  '# core first: every agent depends on it',
  ...order.map((p) => `npm publish --workspace ${p.rel} --access public`),
  'rm -f "$NPM_CONFIG_USERCONFIG"; unset NPM_CONFIG_USERCONFIG',
];
const manual = [
  'Run the tests on Node 20, 22 and 24, and on Windows (the CI workflow does both; this script ran Node ' + process.version + ' on ' + process.platform + ' only).',
  'Back up the website deploy folder and write down the current Cloudflare Pages deployment id before changing the site.',
  'Check the npm maintainers listed above are your own account before publishing.',
  'Tag the release in git after publishing (git tag v' + core.json.version + ').',
];
const report = { created: new Date().toISOString(), node: process.version, platform: process.platform, ok: !failed.length, failed: failed.length, warnings: warned.length, skipped: skipped.length, checks, packages: packs, registry, publish_order: order.map((p) => `${p.json.name}@${p.json.version}`), publish_commands: publish, manual_steps: manual, note: 'Dry run. Nothing was published.' };
const outDir = join(ROOT, 'mythos-out', 'release-check'); mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'release-check.json'), JSON.stringify(report, null, 2) + '\n');
const md = [`# Release check`, '', `${report.created} · Node ${process.version} · ${process.platform}`, '', `**${report.ok ? 'Ready to publish (dry run passed)' : `Not ready: ${failed.length} check(s) failed`}**${warned.length ? `, ${warned.length} warning(s)` : ''}${skipped.length ? `, ${skipped.length} skipped` : ''}. Nothing was published.`, '', '| Check | Result | Detail |', '|---|---|---|',
  ...checks.map((c) => `| ${c.area} | ${c.status} | ${c.message.replace(/\|/g, '\\|')} |`), '',
  ...checks.filter((c) => c.detail && c.status !== 'pass').flatMap((c) => [`## ${c.area}`, '', ...c.detail.map((d) => `- ${String(d).replace(/\|/g, '\\|')}`), '']),
  '## Publish commands (run them yourself)', '', '```sh', ...publish, '```', '', '## Manual steps', '', ...manual.map((m) => `- ${m}`), ''].join('\n');
writeFileSync(join(outDir, 'release-check.md'), md);
if (JSON_OUT) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  process.stdout.write(`\n${report.ok ? 'Dry run passed' : `NOT READY: ${failed.length} check(s) failed`}${warned.length ? `, ${warned.length} warning(s)` : ''}${skipped.length ? `, ${skipped.length} skipped` : ''}. Nothing was published.\n`);
  for (const c of [...failed, ...warned]) { process.stdout.write(`\n${c.status.toUpperCase()} ${c.area}: ${c.message}\n`); for (const d of (c.detail || []).slice(0, 15)) process.stdout.write(`  - ${d}\n`); }
  if (report.ok) process.stdout.write(`\nPublish order and commands (run them yourself):\n${publish.map((l) => '  ' + l).join('\n')}\n`);
  process.stdout.write(`\nManual steps:\n${manual.map((m) => '  - ' + m).join('\n')}\n\nReport: ${relative(ROOT, join(outDir, 'release-check.md'))}\n`);
}
process.exit(failed.length ? 1 : 0);
