import { readFileSync, readdirSync, statSync } from 'node:fs';
import { scryptSync } from 'node:crypto';
import { join, extname, basename } from 'node:path';
import { parseCsv, sha256, canonical } from 'mythos-agent-core';
import { parseYamlAll } from './yaml.js';

const SECRET = /(pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential|auth[_-]?key|client[_-]?secret|dsn|connection[_-]?string)/i;
const HIGH = [/\b(tls|ssl|https?_only|cors|allow[_-]?origins?|auth|mfa|2fa|sso|public|acl|firewall|ingress|cidr|0\.0\.0\.0|encrypt|kms|iam|role|permission|admin|debug|verify)/i, /(privileged|host_?network|host_?pid|host_?ipc|host_?path|privilege_?escalation|run_?as_?(non_?)?root|run_?as_?user|deletion_?protection|skip_final_snapshot|security_?context|capabilities)/i];
const MED = [/(port|host|url|endpoint|region|replica|timeout|retention|backup|log[_-]?level|rate[_-]?limit|max|min|version|image|tag|resources|limits|requests)/i];
export const SNAPSHOT_EXTS = ['.json', '.env', '.properties', '.csv', '.conf', '.ini', '.yaml', '.yml', '.tfstate'];

// Kubernetes fields the API server changes on its own; dropped on load so they never show as drift.
const K8S_META_NOISE = ['resourceVersion', 'uid', 'creationTimestamp', 'generation', 'managedFields', 'selfLink'];
const K8S_ANNOT_NOISE = ['kubectl.kubernetes.io/last-applied-configuration', 'deployment.kubernetes.io/revision'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Arrays of objects that all carry a unique string "name" (containers, env, ports, volumes) become maps keyed by name, so keys stay stable when order changes. */
function byName(v) {
  if (Array.isArray(v)) {
    const named = v.length > 0 && v.every((x) => isObj(x) && typeof x.name === 'string' && x.name) && new Set(v.map((x) => x.name)).size === v.length;
    if (named) return Object.fromEntries(v.map(({ name, ...rest }) => [name, byName(rest)]));
    return v.map(byName);
  }
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, byName(x)]));
  return v;
}

function k8sSnapshot(docs) {
  const objs = docs.flatMap((d) => (isObj(d) && d.kind === 'List' && Array.isArray(d.items) ? d.items : [d])).filter((d) => d !== null && d !== undefined);
  const data = {}, sensitive = new Set(), resources = [];
  for (const d of objs) {
    if (!isObj(d) || !d.kind || !isObj(d.metadata) || !d.metadata.name) throw new Error('every Kubernetes object needs kind and metadata.name');
    const addr = `${d.kind}/${d.metadata.namespace || 'default'}/${d.metadata.name}`;
    if (resources.includes(addr)) throw new Error(`duplicate Kubernetes object ${addr}`);
    resources.push(addr);
    const { kind, status, ...rest } = d; const meta = { ...d.metadata }; delete meta.name; delete meta.namespace;
    for (const k of K8S_META_NOISE) delete meta[k];
    if (isObj(meta.annotations)) { meta.annotations = { ...meta.annotations }; for (const k of K8S_ANNOT_NOISE) delete meta.annotations[k]; if (!Object.keys(meta.annotations).length) delete meta.annotations; }
    rest.metadata = meta; if (!Object.keys(meta).length) delete rest.metadata;
    const flat = flatten(byName(rest));
    for (const [k, v] of Object.entries(flat)) { const key = `${addr}.${k}`; data[key] = v; if (kind === 'Secret' && /^(data|stringData)\./.test(k)) sensitive.add(key); }
  }
  return { kind: 'kubernetes', format: 'kubernetes', data, sensitive, resources };
}

function tfPath(steps) {
  return (steps || []).map((s) => (s.type === 'get_attr' ? `.${s.value}` : s.value && typeof s.value === 'object' ? (s.value.type === 'number' ? `[${s.value.value}]` : `.${s.value.value}`) : `[${s.value}]`)).join('');
}
function tfSnapshot(state) {
  if (!Array.isArray(state.resources)) throw new Error('Terraform state has no resources array');
  const data = {}, sensitive = new Set(), resources = [];
  for (const r of state.resources) {
    const base = `${r.module ? r.module + '.' : ''}${r.mode === 'data' ? 'data.' : ''}${r.type}.${r.name}`;
    for (const inst of r.instances || []) {
      const addr = base + (inst.index_key !== undefined ? `[${JSON.stringify(inst.index_key)}]` : '');
      resources.push(addr);
      const flat = flatten(inst.attributes || {});
      const sens = (inst.sensitive_attributes || []).map((p) => addr + tfPath(Array.isArray(p) ? p : [p]));
      for (const [k, v] of Object.entries(flat)) {
        const key = `${addr}.${k}`; data[key] = v;
        if (sens.some((s) => key === s || key.startsWith(s + '.') || key.startsWith(s + '['))) sensitive.add(key);
      }
    }
  }
  return { kind: 'terraform', format: 'tfstate', data, sensitive, resources };
}

/**
 * Load a snapshot: JSON config, .env / .properties (KEY=value), schema CSV (table, column, type, nullable),
 * Terraform state (.tfstate or JSON with resources), Kubernetes manifests (YAML or JSON, multi-document and
 * List), or plain YAML config.
 */
export function loadSnapshot(file) {
  const text = readFileSync(file, 'utf8'); const ext = extname(file).toLowerCase();
  if (ext === '.json' || ext === '.tfstate') {
    const raw = JSON.parse(text);
    if (isObj(raw) && Array.isArray(raw.resources) && (raw.terraform_version !== undefined || raw.version === 4 || ext === '.tfstate')) return { ...tfSnapshot(raw), text };
    if (isObj(raw) && raw.kind && (raw.apiVersion || raw.kind === 'List')) return { ...k8sSnapshot([raw]), text };
    if (ext === '.tfstate') throw new Error(`${basename(file)} is not Terraform state`);
    return { kind: 'config', format: 'json', data: flatten(raw), sensitive: new Set(), raw, text };
  }
  if (ext === '.yaml' || ext === '.yml') {
    const docs = parseYamlAll(text);
    if (docs.some((d) => isObj(d) && d.kind)) return { ...k8sSnapshot(docs), text };
    if (docs.length !== 1) throw new Error(`${basename(file)}: several YAML documents without Kubernetes "kind"`);
    return { kind: 'config', format: 'yaml', data: flatten(docs[0] ?? {}), sensitive: new Set(), raw: docs[0], text };
  }
  if (ext === '.csv') {
    const rows = parseCsv(text); const k = (r, n) => r[Object.keys(r).find((x) => x.toLowerCase() === n) ?? ''] ?? '';
    if (rows.length && Object.keys(rows[0]).some((x) => x.toLowerCase() === 'column')) {
      const data = {};
      for (const r of rows) data[`${k(r, 'table')}.${k(r, 'column')}`] = { type: String(k(r, 'type')).toLowerCase(), nullable: String(k(r, 'nullable')).toLowerCase(), default: k(r, 'default') };
      return { kind: 'schema', format: 'schema-csv', data, sensitive: new Set(), text };
    }
  }
  const data = {};
  for (const line of text.split(/\r?\n/)) { const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_.\-]+)\s*[=:]\s*(.*?)\s*$/); if (m && !line.trim().startsWith('#')) data[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  return { kind: 'config', format: 'env', data, sensitive: new Set(), text };
}
export function flatten(o, pre = '', out = {}) {
  if (o && typeof o === 'object' && !Array.isArray(o)) { for (const [k, v] of Object.entries(o)) flatten(v, pre ? `${pre}.${k}` : k, out); if (!Object.keys(o).length && pre) out[pre] = {}; }
  else if (Array.isArray(o) && o.every((x) => x === null || typeof x !== 'object')) out[pre] = JSON.stringify(o);
  else if (Array.isArray(o)) o.forEach((v, i) => flatten(v, `${pre}[${i}]`, out));
  else out[pre] = o;
  return out;
}
export const SECRET_MASK = '••• (secret, value not shown)';
export const isSecret = (key, snaps = []) => SECRET.test(key) || snaps.some((s) => s && s.sensitive && s.sensitive.has(key));
const show = (v) => (v === undefined ? '(absent)' : typeof v === 'string' ? v : JSON.stringify(v));
const ignored = (key, ignore) => ignore.some((p) => key === p || key.startsWith(p + '.') || (p.endsWith('*') && key.startsWith(p.slice(0, -1))));
/** Short, salted fingerprint of a value: lets an approved drift be recognised later without storing the value. */
export const fingerprint = (key, v, secret = false) => (secret && v !== undefined
  // Secrets get a deliberately slow, key-salted hash (scrypt) so the stored fingerprint is costly to guess from.
  ? scryptSync(canonical(v), `tiresias-of-drift|${key}`, 8).toString('hex')
  : sha256(`${key}\u0000${v === undefined ? '<absent>' : canonical(v)}`).slice(0, 16));

function riskOf(key, before, after, kind, secret) {
  if (kind === 'schema') {
    if (after === undefined) return ['high', 'Column dropped: queries, reports and integrations that use it will break; data may be lost.'];
    if (before === undefined) return ['low', 'Column added.'];
    if (before.type !== after.type) return ['high', `Type changed ${before.type} → ${after.type}: values may be truncated or casts may fail.`];
    if (before.nullable !== after.nullable) return [after.nullable === 'no' || after.nullable === 'false' ? 'high' : 'medium', `Nullability changed ${before.nullable} → ${after.nullable}.`];
    return ['low', 'Default changed.'];
  }
  if (secret) return ['high', before === undefined ? 'A secret was added to the snapshot.' : after === undefined ? 'A secret was removed.' : 'A secret value changed (rotation or leak?). Confirm it was intentional.'];
  const v = String(after);
  if (/debug|verbose/i.test(key) && /^(true|1|on|yes)$/i.test(v)) return ['high', 'Debug turned on: can expose internals and slow the service.'];
  if (/0\.0\.0\.0\/0|::\/0|"\*"|^\*$/.test(v)) return ['high', 'Opened to everyone (0.0.0.0/0 or *).'];
  if (/(tls|ssl|verify|encrypt|mfa|https)/i.test(key) && /^(false|0|off|no|disabled)$/i.test(v)) return ['high', 'A security control was switched off.'];
  if (/(^|\.)privileged$/i.test(key) && v === 'true') return ['high', 'Container now runs privileged: it has full access to the node.'];
  if (/(host_?network|host_?pid|host_?ipc)$/i.test(key) && v === 'true') return ['high', 'Pod now shares the node\'s network, process or IPC namespace.'];
  if (/allow_?privilege_?escalation$/i.test(key) && v === 'true') return ['high', 'Privilege escalation allowed in the container.'];
  if (/run_?as_?non_?root$/i.test(key) && v === 'false') return ['high', 'Container may now run as root.'];
  if (/run_?as_?user$/i.test(key) && v === '0') return ['high', 'Container runs as root (uid 0).'];
  if (/(^|\.)spec\.type$/.test(key) && /^(LoadBalancer|NodePort)$/.test(v)) return ['high', 'Service exposed outside the cluster.'];
  if (/deletion_?protection$/i.test(key) && /^(false|0)$/i.test(v)) return ['high', 'Deletion protection turned off.'];
  if (/skip_final_snapshot$/i.test(key) && v === 'true') return ['high', 'Final snapshot skipped on delete: data could be lost.'];
  if (/publicly_?accessible$/i.test(key) && v === 'true') return ['high', 'Resource made publicly accessible.'];
  if (/(^|\.)image$/i.test(key) && after !== undefined && (/:latest$/.test(v) || !/[:@]/.test(v.split('/').pop()))) return ['high', 'Image now uses a mutable tag (latest or none): what runs can change without a deploy.'];
  if (HIGH.some((r) => r.test(key))) return ['high', 'Security-relevant setting changed.'];
  if (after === undefined) return ['medium', 'Setting removed: the default will apply.'];
  if (MED.some((r) => r.test(key))) return ['medium', 'Operational setting changed.'];
  return ['low', before === undefined ? 'Setting added.' : 'Setting changed.'];
}

const ORDER = { high: 0, medium: 1, low: 2 };
const ACCESS = /(iam|role|policy|security_group|firewall|network_acl|ClusterRole|RoleBinding|NetworkPolicy|ServiceAccount)/i;
const resourceOf = (key, resources) => (resources || []).filter((r) => key === r || key.startsWith(r + '.') || key.startsWith(r + '[')).sort((x, y) => y.length - x.length)[0] || null;

/**
 * Compare two snapshots and explain every change, highest risk first. Secret values are never shown.
 * opts.ignore: keys or prefixes to skip. opts.approved: [{ key, after_fp }] drift a person accepted;
 * an approved change is listed under approved_items and does not count until its value changes again.
 */
export function diff(a, b, opts = {}) {
  const ignore = opts.ignore || [];
  if (a.kind !== b.kind) throw new Error(`cannot compare a ${a.kind} snapshot with a ${b.kind} snapshot`);
  const keys = [...new Set([...Object.keys(a.data), ...Object.keys(b.data)])].filter((k) => !ignored(k, ignore)).sort();
  let changes = [];
  for (const k of keys) {
    const x = a.data[k], y = b.data[k];
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    const secret = a.kind !== 'schema' && isSecret(k, [a, b]);
    const [risk, why] = riskOf(k, x, y, a.kind, secret);
    const hide = (v) => (secret && v !== undefined && v !== '' ? SECRET_MASK : v);
    changes.push({ key: k, change: x === undefined ? 'added' : y === undefined ? 'removed' : 'changed', before: a.kind === 'schema' ? x : hide(x), after: a.kind === 'schema' ? y : hide(y), risk, why, ...(secret ? { secret: true } : {}), after_fp: fingerprint(k, y, secret) });
  }
  let resources = null;
  if (a.resources && b.resources) {
    const A = new Set(a.resources), B = new Set(b.resources);
    const removed = a.resources.filter((r) => !B.has(r) && !ignored(r, ignore)), added = b.resources.filter((r) => !A.has(r) && !ignored(r, ignore));
    const collapse = (r, change) => {
      const mine = changes.filter((c) => resourceOf(c.key, change === 'removed' ? a.resources : b.resources) === r); changes = changes.filter((c) => !mine.includes(c));
      const worst = mine.reduce((w, c) => (ORDER[c.risk] < ORDER[w.risk] ? c : w), { risk: 'low', why: '' });
      const highs = [...new Set(mine.filter((c) => c.risk === 'high' && change === 'added').map((c) => c.why))].slice(0, 3);
      const attrs = Object.keys((change === 'removed' ? a : b).data).filter((k) => resourceOf(k, change === 'removed' ? a.resources : b.resources) === r);
      const fpVal = change === 'removed' ? undefined : Object.fromEntries(attrs.map((k) => [k, isSecret(k, [b]) ? fingerprint(k, b.data[k], true) : b.data[k]]));
      if (change === 'removed') return { key: r, resource: r, change, before: `${attrs.length} attribute(s)`, after: undefined, risk: a.kind === 'terraform' ? 'high' : 'medium', why: a.kind === 'terraform' ? 'Resource gone from state: destroyed, renamed or moved out of Terraform.' : 'Object removed from the manifests.', after_fp: fingerprint(r, fpVal) };
      return { key: r, resource: r, change, before: undefined, after: `${attrs.length} attribute(s)`, risk: worst.risk === 'high' || ACCESS.test(r) ? 'high' : worst.risk, why: `Resource added.${ACCESS.test(r) ? ' It grants or controls access; confirm who created it.' : ''}${highs.length ? ' ' + highs.join(' ') : ''}`, after_fp: fingerprint(r, fpVal) };
    };
    const extra = [...removed.map((r) => collapse(r, 'removed')), ...added.map((r) => collapse(r, 'added'))];
    for (const c of changes) c.resource = resourceOf(c.key, b.resources) || resourceOf(c.key, a.resources);
    changes.push(...extra);
    resources = { added, removed, changed: [...new Set(changes.filter((c) => c.change !== 'added' || !added.includes(c.key)).filter((c) => c.change !== 'removed' || !removed.includes(c.key)).map((c) => c.resource).filter(Boolean))].sort() };
  }
  const approvedMap = new Map((opts.approved || []).map((x) => [x.key, x]));
  const approvedItems = [];
  changes = changes.filter((c) => {
    const ap = approvedMap.get(c.key);
    if (ap && ap.after_fp === c.after_fp) { approvedItems.push({ ...c, approved_at: ap.approved_at || null, approval_reason: ap.reason || '' }); return false; }
    if (ap) { c.approved_before = true; c.why = `Changed again since it was approved. ${c.why}`; }
    return true;
  });
  changes.sort((p, q) => ORDER[p.risk] - ORDER[q.risk] || p.key.localeCompare(q.key));
  const by = { high: 0, medium: 0, low: 0 }; for (const c of changes) by[c.risk]++;
  return { kind: a.kind, compared_keys: keys.length, changes: changes.length, by_risk: by, items: changes, ...(resources ? { resources } : {}), ignored: ignore, ...(opts.approved ? { approved: approvedItems.length, approved_items: approvedItems } : {}) };
}

/** Snapshots in a folder, sorted by file name (name them by date, e.g. 2026-11-01.json). */
export function timeline(dir, opts = {}) {
  const files = readdirSync(dir).filter((f) => SNAPSHOT_EXTS.includes(extname(f).toLowerCase()) || f.endsWith('.env')).filter((f) => statSync(join(dir, f)).isFile()).sort();
  if (files.length < 2) throw new Error('need at least two snapshots in the folder');
  const steps = []; const first = new Map();
  for (let i = 1; i < files.length; i++) {
    const d = diff(loadSnapshot(join(dir, files[i - 1])), loadSnapshot(join(dir, files[i])), opts);
    steps.push({ from: files[i - 1], to: files[i], changes: d.changes, by_risk: d.by_risk, items: d.items });
    for (const c of d.items) if (!first.has(c.key)) first.set(c.key, { key: c.key, first_changed_in: files[i], risk: c.risk });
  }
  const baseline = loadSnapshot(join(dir, files[0])); const latest = loadSnapshot(join(dir, files[files.length - 1]));
  const net = diff(baseline, latest, opts);
  return { snapshots: files, baseline: files[0], latest: files[files.length - 1], steps, net_drift: net, first_seen: [...first.values()] };
}

/** A revert plan back to the baseline, as a proposal. Secrets are left as placeholders. */
export function revertPlan(d, label = basename('baseline')) {
  return d.items.map((c) => ({ key: c.key, action: c.change === 'added' ? 'remove' : 'set', to: c.change === 'added' ? null : (typeof c.before === 'string' && c.before.startsWith('•••') ? '<restore from your secret store>' : c.before), risk: c.risk, why: c.why, source: label }));
}
export function reportMarkdown(d, title, at) {
  const L = [`# ${title}`, '', `Generated ${at} by tiresias-of-drift.`, '', `- ${d.changes} change(s): high ${d.by_risk.high}, medium ${d.by_risk.medium}, low ${d.by_risk.low}${d.ignored?.length ? ` · ignored: ${d.ignored.join(', ')}` : ''}${d.approved ? ` · ${d.approved} approved change(s) not counted` : ''}`];
  if (d.resources) L.push(`- Resources: ${d.resources.added.length} added, ${d.resources.removed.length} removed, ${d.resources.changed.length} changed`);
  L.push('', '| Risk | Key | Change | Before | After | Why it matters |', '|---|---|---|---|---|---|');
  const cell = (v) => show(v).replace(/\|/g, '\\|').slice(0, 80);
  for (const c of d.items) L.push(`| ${c.risk} | \`${c.key}\` | ${c.change} | ${cell(c.before)} | ${cell(c.after)} | ${c.why} |`);
  if (d.approved_items && d.approved_items.length) { L.push('', '## Approved drift (not counted)', ''); for (const c of d.approved_items) L.push(`- \`${c.key}\` (${c.risk}) approved ${c.approved_at || ''}${c.approval_reason ? `: ${c.approval_reason}` : ''}`); }
  L.push('', 'Risk levels come from key names and values, not from knowledge of your system. Secret values are never shown. Applying any fix is a separate, approved step.', '');
  return L.join('\n');
}
