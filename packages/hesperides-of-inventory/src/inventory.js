import { toNumber, round2, toCsv } from 'mythos-agent-core';

const norm = (k) => String(k).trim().toLowerCase().replace(/[\s-]+/g, '_');
export function pick(r, ...keys) {
  for (const k of keys) for (const key of Object.keys(r || {})) if (norm(key) === k && String(r[key] ?? '').trim() !== '') return String(r[key]).trim();
  return '';
}
/** Parse YYYY-MM-DD or YYYY-MM-DD[T ]HH:MM[:SS] as UTC. */
export function parseTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s || '').trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : null;
}
const num = (v) => { const n = toNumber(v); return n === null ? null : n; };
const key = (sku, loc) => `${sku.toUpperCase()}|${(loc || '').toUpperCase()}`;
const PACKS = [2, 4, 6, 10, 12, 20, 24, 25, 48, 50, 100];

/**
 * Compare cycle counts with the on-hand snapshot.
 * Statuses: match, within_tolerance, explained_by_timing, recount_needed, confirmed_by_recount, investigate, not_counted.
 */
export function compare(counts, onHand, txns = [], a = {}) {
  const tolUnits = a.tolerance_units !== undefined ? Number(a.tolerance_units) : 0;
  const tolPct = a.tolerance_pct !== undefined ? Number(a.tolerance_pct) : 0.02;
  const valueThreshold = a.value_threshold !== undefined ? Number(a.value_threshold) : 250;
  const snapshotAt = a.snapshot_at ? parseTime(a.snapshot_at) : null;
  if (a.snapshot_at && snapshotAt === null) throw new Error(`snapshot_at must be YYYY-MM-DD or YYYY-MM-DDTHH:MM, got "${a.snapshot_at}"`);
  const sys = new Map();
  for (const r of onHand) {
    const sku = pick(r, 'sku', 'item', 'item_id'); if (!sku) continue;
    sys.set(key(sku, pick(r, 'location', 'bin', 'warehouse')), { sku, location: pick(r, 'location', 'bin', 'warehouse'), description: pick(r, 'description', 'name'), system_qty: num(pick(r, 'system_qty', 'on_hand', 'quantity', 'qty')) ?? 0, unit_cost: num(pick(r, 'unit_cost', 'cost', 'average_cost')), uom: pick(r, 'uom', 'unit').toUpperCase() });
  }
  const moves = new Map();
  for (const t of txns) {
    const k = key(pick(t, 'sku', 'item'), pick(t, 'location', 'bin', 'warehouse')); const at = parseTime(pick(t, 'posted_at', 'date', 'datetime'));
    if (at === null) continue;
    if (!moves.has(k)) moves.set(k, []); moves.get(k).push({ at, qty: num(pick(t, 'qty', 'quantity')) || 0, type: pick(t, 'type'), ref: pick(t, 'ref', 'reference', 'document') });
  }
  const seen = new Set(); const items = [];
  for (const c of counts) {
    const sku = pick(c, 'sku', 'item', 'item_id'); if (!sku) continue;
    const loc = pick(c, 'location', 'bin', 'warehouse'); const k = key(sku, loc); seen.add(k);
    const s = sys.get(k); const first = num(pick(c, 'counted_qty', 'count', 'qty')); const recount = num(pick(c, 'recount_qty', 'recount'));
    const countedAt = parseTime(pick(c, 'counted_at', 'count_date', 'date'));
    const it = { sku, location: loc, description: s ? s.description : '', system_qty: s ? s.system_qty : null, counted_qty: first, recount_qty: recount, uom: s ? s.uom : '', count_uom: pick(c, 'uom', 'unit').toUpperCase(), unit_cost: s ? s.unit_cost : null, counter: pick(c, 'counter', 'counted_by'), counted_at: pick(c, 'counted_at', 'count_date', 'date'), variance_qty: null, variance_value: null, flags: [], notes: [] };
    if (!s) { it.status = 'investigate'; it.flags.push('not_in_system'); it.notes.push('Counted but no on-hand record at this location. Check for a mis-bin or an item not set up.'); items.push(it); continue; }
    if (first === null) { it.status = 'investigate'; it.flags.push('count_missing'); items.push(it); continue; }
    if (it.count_uom && s.uom && it.count_uom !== s.uom) { it.status = 'investigate'; it.flags.push('uom_mismatch'); it.notes.push(`Counted in ${it.count_uom}, system holds ${s.uom}. Convert before comparing.`); items.push(it); continue; }
    if (s.system_qty < 0) it.flags.push('negative_system_qty');
    if (s.unit_cost === null) it.flags.push('unit_cost_missing');
    const final = recount !== null ? recount : first;
    // Movements posted after the count and up to the snapshot are in the system quantity but not in the count.
    const after = (moves.get(k) || []).filter((m) => countedAt !== null && m.at > countedAt && (snapshotAt === null || m.at <= snapshotAt));
    const moved = round2(after.reduce((t, m) => t + m.qty, 0));
    const expected = round2(s.system_qty - moved);
    it.moved_after_count = moved; it.expected_at_count = expected;
    const variance = round2(final - s.system_qty); const adjVariance = round2(final - expected);
    it.variance_qty = adjVariance; it.raw_variance_qty = variance;
    it.variance_value = s.unit_cost === null ? null : round2(adjVariance * s.unit_cost);
    it.variance_pct = expected === 0 ? (adjVariance === 0 ? 0 : null) : round2(adjVariance / expected);
    const absV = Math.abs(it.variance_value ?? 0); const big = absV >= valueThreshold || it.variance_value === null && adjVariance !== 0;
    const small = Math.abs(adjVariance) <= tolUnits || (it.variance_pct !== null && Math.abs(it.variance_pct) <= tolPct);
    if (variance !== 0 && adjVariance === 0) { it.status = 'explained_by_timing'; it.notes.push(`${after.length} movement(s) posted after the count (${after.map((m) => m.ref || m.type).join(', ')}) explain the difference.`); }
    else if (adjVariance === 0) it.status = 'match';
    else if (small && !big) it.status = 'within_tolerance';
    else if (recount === null) it.status = 'recount_needed';
    else if (recount === first) it.status = 'confirmed_by_recount';
    else { it.status = 'investigate'; it.flags.push('recount_differs'); it.notes.push(`First count ${first}, recount ${recount}. Count a third time before adjusting.`); }
    if (moved !== 0 && adjVariance !== 0) it.notes.push(`Adjusted for ${moved} unit(s) moved after the count.`);
    if (adjVariance !== 0 && final > 0 && expected > 0) {
      const r1 = final / expected; const r2 = expected / final;
      const p = PACKS.find((x) => Math.abs(r1 - x) < 1e-9 || Math.abs(r2 - x) < 1e-9);
      if (p) { it.flags.push('possible_uom_error'); it.notes.push(`Count and system differ by a factor of ${p}: check each vs case or pack.`); if (it.status !== 'investigate') it.status = 'investigate'; }
    }
    if (it.flags.includes('negative_system_qty')) { it.status = 'investigate'; it.notes.push('System quantity is negative: look for unposted receipts or shipments posted before receipt.'); }
    items.push(it);
  }
  for (const [k, s] of sys) if (!seen.has(k) && s.system_qty !== 0 && (!a.locations || [].concat(a.locations).map((x) => x.toUpperCase()).includes(s.location.toUpperCase())))
    items.push({ sku: s.sku, location: s.location, description: s.description, system_qty: s.system_qty, counted_qty: null, recount_qty: null, uom: s.uom, unit_cost: s.unit_cost, status: 'not_counted', flags: ['not_counted'], notes: ['In the system with stock but not in this count.'], variance_qty: null, variance_value: null });
  items.sort((x, y) => Math.abs(y.variance_value ?? 0) - Math.abs(x.variance_value ?? 0) || x.sku.localeCompare(y.sku));
  items.forEach((x, i) => { x.rank = i + 1; });
  const count = (s) => items.filter((i) => i.status === s).length;
  const vals = items.filter((i) => i.variance_value !== null && i.variance_value !== undefined);
  return {
    lines: items.length, value_threshold: valueThreshold, tolerance_pct: tolPct, tolerance_units: tolUnits,
    match: count('match'), within_tolerance: count('within_tolerance'), explained_by_timing: count('explained_by_timing'), recount_needed: count('recount_needed'), confirmed_by_recount: count('confirmed_by_recount'), investigate: count('investigate'), not_counted: count('not_counted'),
    net_variance_value: round2(vals.reduce((t, i) => t + i.variance_value, 0)), abs_variance_value: round2(vals.reduce((t, i) => t + Math.abs(i.variance_value), 0)),
    items, note: 'Variance review for a person. Nothing is posted; adjustments are drafts until someone approves and posts them in your system.',
  };
}
export const ADJUSTABLE = ['within_tolerance', 'confirmed_by_recount'];
export const VARIANCE_COLUMNS = ['rank', 'sku', 'location', 'description', 'system_qty', 'moved_after_count', 'counted_qty', 'recount_qty', 'variance_qty', 'unit_cost', 'variance_value', 'status', 'flags', 'notes', 'reviewer', 'decision'];
export const varianceCsv = (r) => toCsv(r.items.map((i) => ({ ...i, flags: i.flags.join('; '), notes: i.notes.join(' '), reviewer: '', decision: '' })), VARIANCE_COLUMNS);
export const ADJ_COLUMNS = ['sku', 'location', 'system_qty', 'counted_qty', 'adjust_qty', 'unit_cost', 'value', 'status', 'reason_code', 'memo'];
export function adjustmentRows(r) {
  return r.items.filter((i) => ADJUSTABLE.includes(i.status)).map((i) => ({ sku: i.sku, location: i.location, system_qty: i.system_qty, counted_qty: i.recount_qty ?? i.counted_qty, adjust_qty: i.variance_qty, unit_cost: i.unit_cost ?? '', value: i.variance_value ?? '', status: i.status, reason_code: '', memo: `Cycle count ${i.counted_at || ''}${i.status === 'confirmed_by_recount' ? ', confirmed by recount' : ''}` }));
}
export function reportMarkdown(r) {
  const L = ['# Cycle count variance review', '', `${r.lines} line(s): match ${r.match}, within tolerance ${r.within_tolerance}, timing ${r.explained_by_timing}, recount needed ${r.recount_needed}, confirmed by recount ${r.confirmed_by_recount}, investigate ${r.investigate}, not counted ${r.not_counted}.`, `Net variance ${r.net_variance_value.toFixed(2)}; absolute ${r.abs_variance_value.toFixed(2)} (value threshold ${r.value_threshold}).`, '', `> ${r.note}`, '', '| # | SKU | Location | System | Counted | Variance | Value | Status |', '|---|---|---|---|---|---|---|---|'];
  for (const i of r.items) L.push(`| ${i.rank} | ${i.sku} | ${i.location} | ${i.system_qty ?? '—'} | ${i.recount_qty ?? i.counted_qty ?? '—'} | ${i.variance_qty ?? '—'} | ${i.variance_value ?? '—'} | ${i.status}${i.flags.length ? ` (${i.flags.join(', ')})` : ''} |`);
  const n = r.items.filter((i) => i.notes.length); if (n.length) { L.push('', '## Notes', ''); for (const i of n) L.push(`- ${i.sku} @ ${i.location}: ${i.notes.join(' ')}`); }
  return L.join('\n') + '\n';
}
