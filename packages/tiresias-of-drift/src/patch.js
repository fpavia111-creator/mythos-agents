// Revert plan as a unified-diff patch: applying it to the newer snapshot puts the selected
// keys back to their earlier values. Secrets are never written into a patch; they become
// manual steps ("restore from your secret store"). JSON config and .env/.properties only.

import { unifiedDiff, applyUnifiedDiff } from 'mythos-agent-core';
import { diff, isSecret } from './drift.js';

const DEL = Symbol('delete');
const isBranch = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) || (Array.isArray(v) && v.some((x) => x !== null && typeof x === 'object'));
const under = (k, p) => k === p || k.startsWith(p + '.') || k.startsWith(p + '[');
const copy = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function revertTree(b, a, pre, ok) {
  if (isBranch(a) && isBranch(b) && Array.isArray(a) === Array.isArray(b)) {
    if (Array.isArray(a)) { const out = []; for (let i = 0; i < Math.max(a.length, b.length); i++) { const v = revertTree(b[i], a[i], `${pre}[${i}]`, ok); if (v !== DEL) out.push(v); } return out; }
    const out = {};
    for (const k of [...Object.keys(a), ...Object.keys(b).filter((x) => !(x in a))]) { const v = revertTree(b[k], a[k], pre ? `${pre}.${k}` : k, ok); if (v !== DEL) out[k] = v; }
    return out;
  }
  if (ok(pre)) return b === undefined ? DEL : copy(b);
  return a === undefined ? DEL : a;
}

const ENV_LINE = /^(\s*(?:export\s+)?)([A-Za-z0-9_.\-]+)(\s*[=:]\s*)(.*?)\s*$/;
function envTarget(beforeData, afterText, selected) {
  const lines = afterText.split('\n'); const out = []; const seen = new Set();
  for (const line of lines) {
    const m = ENV_LINE.exec(line);
    if (!m || line.trim().startsWith('#') || !selected.has(m[2])) { out.push(line); continue; }
    seen.add(m[2]);
    if (!(m[2] in beforeData)) continue; // added since: remove the line
    const q = /^(["']).*\1$/.exec(m[4]); const v = String(beforeData[m[2]]);
    out.push(`${m[1]}${m[2]}${m[3]}${q ? q[1] + v + q[1] : v}`);
  }
  const add = [...selected].filter((k) => !seen.has(k) && k in beforeData).sort().map((k) => `${k}=${beforeData[k]}`);
  if (add.length) { const end = out.length && out[out.length - 1] === '' ? out.length - 1 : out.length; out.splice(end, 0, ...add); }
  return out.join('\n');
}

/**
 * before/after: snapshots from loadSnapshot. opts: { ignore, approved, keys, afterPath }.
 * Returns { patch, base_text, target_text, applies_to, reverted, manual_steps, not_reverted }.
 */
export function revertPatch(before, after, opts = {}) {
  if (before.kind !== 'config' || !['json', 'env'].includes(before.format) || before.format !== after.format) {
    throw new Error(`revert patches are written for JSON config and .env/.properties snapshots only (got ${after.format || after.kind}). For Terraform, plan the change in your code; for Kubernetes, re-apply the earlier manifest through your change process. tiresias_write_report still writes a revert plan.`);
  }
  const d = diff(before, after, { ignore: opts.ignore || [], approved: opts.approved });
  const want = opts.keys && opts.keys.length ? new Set(opts.keys) : null;
  const manual = [], notReverted = [];
  const selected = new Set();
  for (const c of d.items) {
    if (want && !want.has(c.key)) { notReverted.push({ key: c.key, reason: 'not in keys' }); continue; }
    if (c.secret || isSecret(c.key, [before, after])) { manual.push({ key: c.key, step: c.change === 'added' ? 'Remove this secret through your secret store.' : 'Restore the earlier value from your secret store; secrets are never written into a patch.' }); continue; }
    selected.add(c.key);
  }
  if (want) for (const k of want) if (!d.items.some((c) => c.key === k)) notReverted.push({ key: k, reason: 'no drift on this key (or ignored/approved)' });
  const allChanged = [...new Set([...Object.keys(before.data), ...Object.keys(after.data)])].filter((k) => JSON.stringify(before.data[k]) !== JSON.stringify(after.data[k]));
  let base, target, appliesTo;
  if (after.format === 'json') {
    const pretty = JSON.stringify(after.raw, null, 2);
    const original = after.text === pretty || after.text === pretty + '\n';
    base = original ? after.text : pretty + '\n';
    appliesTo = original ? 'original' : 'normalized';
    // Revert a node only when every drifted key under it was selected (never drags a secret or an ignored key along).
    const ok = (p) => { const u = allChanged.filter((k) => under(k, p)); return u.length > 0 && u.every((k) => selected.has(k)); };
    const t = revertTree(before.raw, after.raw, '', ok);
    target = JSON.stringify(t === DEL ? {} : t, null, 2) + (base.endsWith('\n') ? '\n' : '');
  } else {
    base = after.text; appliesTo = 'original';
    target = envTarget(before.data, after.text, selected);
  }
  const p = opts.afterPath || 'snapshot';
  // Context lines must not carry a secret value: shrink the context until none does.
  const secrets = [...new Set([...Object.entries(before.data), ...Object.entries(after.data)].filter(([k, v]) => isSecret(k, [before, after]) && v !== undefined && v !== null && String(v).length > 0).map(([, v]) => String(v)))];
  let patch = '';
  for (const context of [3, 2, 1, 0]) {
    patch = unifiedDiff(base, target, { oldPath: `a/${p}`, newPath: `b/${p}`, context });
    if (!secrets.some((v) => patch.split('\n').slice(2).some((l) => l.includes(v)))) break;
  }
  if (secrets.some((v) => patch.includes(v))) throw new Error('refusing to write a patch that would contain a secret value');
  if (applyUnifiedDiff(base, patch) !== target) throw new Error('internal check failed: the revert patch does not apply to the snapshot it was made from');
  return { patch, base_text: base, target_text: target, applies_to: appliesTo, reverted: [...selected].sort(), manual_steps: manual, not_reverted: notReverted, ...(d.approved !== undefined ? { approved_not_reverted: d.approved_items.map((c) => c.key) } : {}) };
}
