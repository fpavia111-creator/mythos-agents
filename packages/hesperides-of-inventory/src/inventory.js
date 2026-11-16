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
const key = (sku, loc, lot = '') => `${sku.toUpperCase()}|${(loc || '').toUpperCase()}|${(lot || '').toUpperCase()}`;
const lotOf = (r) => pick(r, 'lot', 'lot_number', 'batch', 'serial', 'serial_number');
const isSerial = (r) => !!pick(r, 'serial', 'serial_number');
/** Line id used for reason codes and holds: SKU@LOCATION, or SKU@LOCATION#LOT for lot/serial lines. */
export const lineId = (i) => `${i.sku}@${i.location}${i.lot ? `#${i.lot}` : ''}`;

/**
 * Find a unit conversion from one unit to another in a conversion table
 * ({ conversions: [{ sku?, from, to, factor }] }). SKU-specific rows win; the inverse is used if needed.
 * Returns { factor, row } where qty_in_from × factor = qty_in_to, or null.
 */
export function findConversion(table, sku, from, to) {
  const rows = (table && table.conversions) || []; const S = String(sku || '').toUpperCase(); const F = String(from || '').toUpperCase(); const T = String(to || '').toUpperCase();
  for (const specific of [true, false]) for (const r of rows) {
    if (specific ? String(r.sku || '').toUpperCase() !== S : r.sku) continue;
    if (String(r.from).toUpperCase() === F && String(r.to).toUpperCase() === T) return { factor: Number(r.factor), row: r };
    if (String(r.from).toUpperCase() === T && String(r.to).toUpperCase() === F) return { factor: 1 / Number(r.factor), row: r };
  }
  return null;
}
/** Every factor in the table for a SKU (SKU rows first, then generic), as { factor, from, to }. */
function factorsFor(table, sku) {
  const rows = (table && table.conversions) || []; const S = String(sku || '').toUpperCase();
  return rows.filter((r) => String(r.sku || '').toUpperCase() === S).concat(rows.filter((r) => !r.sku)).map((r) => ({ factor: Number(r.factor), from: String(r.from).toUpperCase(), to: String(r.to).toUpperCase(), sku: r.sku || '' }));
}
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
  const uomTable = a.uom_table || null;
  const sys = new Map();
  for (const r of onHand) {
    const sku = pick(r, 'sku', 'item', 'item_id'); if (!sku) continue;
    sys.set(key(sku, pick(r, 'location', 'bin', 'warehouse'), lotOf(r)), { sku, location: pick(r, 'location', 'bin', 'warehouse'), lot: lotOf(r), serial: isSerial(r), expiry: pick(r, 'expiry', 'expiry_date', 'best_before'), description: pick(r, 'description', 'name'), system_qty: num(pick(r, 'system_qty', 'on_hand', 'quantity', 'qty')) ?? 0, unit_cost: num(pick(r, 'unit_cost', 'cost', 'average_cost')), uom: pick(r, 'uom', 'unit').toUpperCase() });
  }
  const moves = new Map();
  for (const t of txns) {
    const k = key(pick(t, 'sku', 'item'), pick(t, 'location', 'bin', 'warehouse'), lotOf(t)); const at = parseTime(pick(t, 'posted_at', 'date', 'datetime'));
    if (at === null) continue;
    if (!moves.has(k)) moves.set(k, []); moves.get(k).push({ at, qty: num(pick(t, 'qty', 'quantity')) || 0, type: pick(t, 'type'), ref: pick(t, 'ref', 'reference', 'document') });
  }
  const seen = new Set(); const items = [];
  for (const c of counts) {
    const sku = pick(c, 'sku', 'item', 'item_id'); if (!sku) continue;
    const loc = pick(c, 'location', 'bin', 'warehouse'); const lot = lotOf(c); const k = key(sku, loc, lot); seen.add(k);
    const s = sys.get(k); let first = num(pick(c, 'counted_qty', 'count', 'qty')); let recount = num(pick(c, 'recount_qty', 'recount'));
    const countedAt = parseTime(pick(c, 'counted_at', 'count_date', 'date'));
    const it = { sku, location: loc, lot, description: s ? s.description : '', system_qty: s ? s.system_qty : null, counted_qty: first, recount_qty: recount, uom: s ? s.uom : '', count_uom: pick(c, 'uom', 'unit').toUpperCase(), unit_cost: s ? s.unit_cost : null, counter: pick(c, 'counter', 'counted_by'), counted_at: pick(c, 'counted_at', 'count_date', 'date'), variance_qty: null, variance_value: null, flags: [], notes: [] };
    if (!s) { it.status = 'investigate'; it.flags.push('not_in_system'); it.notes.push(lot ? `Counted lot/serial ${lot} but there is no on-hand record for it at this location. Check the lot label or a mis-bin.` : 'Counted but no on-hand record at this location. Check for a mis-bin or an item not set up.'); items.push(it); continue; }
    if (first === null) { it.status = 'investigate'; it.flags.push('count_missing'); items.push(it); continue; }
    if (it.count_uom && s.uom && it.count_uom !== s.uom) {
      const conv = findConversion(uomTable, sku, it.count_uom, s.uom);
      if (!conv) { it.status = 'investigate'; it.flags.push('uom_mismatch'); it.notes.push(`Counted in ${it.count_uom}, system holds ${s.uom}${uomTable ? ' and the conversion table has no factor between them' : ''}. Convert before comparing.`); items.push(it); continue; }
      const f = conv.factor; const c1 = round2(first * f);
      it.flags.push('uom_converted'); it.notes.push(`Counted ${first} ${it.count_uom} × ${round2(f)} = ${c1} ${s.uom} (conversion table${conv.row.sku ? ` for ${conv.row.sku}` : ''}: 1 ${String(conv.row.from).toUpperCase()} = ${conv.row.factor} ${String(conv.row.to).toUpperCase()}).`);
      it.counted_in_count_uom = first; first = c1; it.counted_qty = c1; if (recount !== null) { recount = round2(recount * f); it.recount_qty = recount; }
    }
    if (s.serial && Math.max(first, recount ?? 0) > 1) { it.flags.push('serial_qty_over_one'); it.notes.push(`Serial ${lot} counted as ${Math.max(first, recount ?? 0)}; a serial number is one unit. Check for a duplicated label.`); }
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
    if (adjVariance !== 0 && final > 0 && expected > 0 && !(s.serial && !factorsFor(uomTable, sku).length)) {
      const r1 = final / expected; const r2 = expected / final;
      const conf = factorsFor(uomTable, sku).find((x) => Math.abs(r1 - x.factor) < 1e-9 || Math.abs(r2 - x.factor) < 1e-9);
      const p = conf ? conf.factor : s.serial ? undefined : PACKS.find((x) => Math.abs(r1 - x) < 1e-9 || Math.abs(r2 - x) < 1e-9);
      if (p) {
        it.flags.push('possible_uom_error');
        it.notes.push(conf ? `Count and system differ by a factor of ${p}, the ${conf.from}→${conf.to} factor${conf.sku ? ` for ${conf.sku}` : ''} in your conversion table: ${r1 < 1 ? `likely counted in ${conf.from} but entered as ${conf.to}` : `likely counted in ${conf.to} where ${conf.from} was expected`} (${final} × ${p} = ${round2(final * p)}, ${final} ÷ ${p} = ${round2(final / p)}; system ${expected}).` : `Count and system differ by a factor of ${p}: check each vs case or pack.`);
        it.uom_factor = p; if (it.status !== 'investigate') it.status = 'investigate';
      }
    }
    if (it.flags.includes('serial_qty_over_one')) it.status = 'investigate';
    if (it.flags.includes('negative_system_qty')) { it.status = 'investigate'; it.notes.push('System quantity is negative: look for unposted receipts or shipments posted before receipt.'); }
    items.push(it);
  }
  for (const [k, s] of sys) if (!seen.has(k) && s.system_qty !== 0 && (!a.locations || [].concat(a.locations).map((x) => x.toUpperCase()).includes(s.location.toUpperCase())))
    items.push({ sku: s.sku, location: s.location, lot: s.lot, description: s.description, system_qty: s.system_qty, counted_qty: null, recount_qty: null, uom: s.uom, unit_cost: s.unit_cost, status: 'not_counted', flags: ['not_counted'], notes: ['In the system with stock but not in this count.'], variance_qty: null, variance_value: null });
  // Lot mix-ups: per-lot variances at one SKU and location that cancel out.
  const groups = new Map();
  for (const i of items) if (i.lot) { const g = `${i.sku.toUpperCase()}|${(i.location || '').toUpperCase()}`; groups.set(g, [...(groups.get(g) || []), i]); }
  for (const g of groups.values()) {
    const off = g.filter((i) => (i.variance_qty ?? 0) !== 0 || i.status === 'not_counted' || i.flags.includes('not_in_system'));
    const net = round2(g.reduce((t, i) => t + (i.variance_qty ?? (i.status === 'not_counted' ? -i.system_qty : i.flags.includes('not_in_system') ? (i.recount_qty ?? i.counted_qty ?? 0) : 0)), 0));
    if (off.length >= 2 && net === 0) for (const i of off) { i.flags.push('lot_mixup'); i.notes.push(`Lot variances at ${i.sku} @ ${i.location} (${off.map((x) => x.lot).join(', ')}) net to 0: likely counted or picked under the wrong lot. Fix the lot records rather than adjusting quantity.`); if (i.status !== 'not_counted') i.status = 'investigate'; }
  }
  items.sort((x, y) => Math.abs(y.variance_value ?? 0) - Math.abs(x.variance_value ?? 0) || x.sku.localeCompare(y.sku));
  items.forEach((x, i) => { x.rank = i + 1; });
  const count = (s) => items.filter((i) => i.status === s).length;
  const vals = items.filter((i) => i.variance_value !== null && i.variance_value !== undefined);
  return {
    lines: items.length, value_threshold: valueThreshold, tolerance_pct: tolPct, tolerance_units: tolUnits,
    match: count('match'), within_tolerance: count('within_tolerance'), explained_by_timing: count('explained_by_timing'), recount_needed: count('recount_needed'), confirmed_by_recount: count('confirmed_by_recount'), investigate: count('investigate'), not_counted: count('not_counted'),
    net_variance_value: round2(vals.reduce((t, i) => t + i.variance_value, 0)), abs_variance_value: round2(vals.reduce((t, i) => t + Math.abs(i.variance_value), 0)),
    lots: items.filter((i) => i.lot).length,
    items, note: 'Variance review for a person. Nothing is posted; adjustments are drafts until someone approves and posts them in your system.',
  };
}
export const ADJUSTABLE = ['within_tolerance', 'confirmed_by_recount'];
export const VARIANCE_COLUMNS = ['rank', 'sku', 'location', 'lot', 'description', 'system_qty', 'moved_after_count', 'counted_qty', 'recount_qty', 'variance_qty', 'unit_cost', 'variance_value', 'status', 'flags', 'notes', 'reviewer', 'decision'];
export const varianceCsv = (r) => toCsv(r.items.map((i) => ({ ...i, flags: i.flags.join('; '), notes: i.notes.join(' '), reviewer: '', decision: '' })), VARIANCE_COLUMNS);
export const ADJ_COLUMNS = ['sku', 'location', 'lot', 'system_qty', 'counted_qty', 'adjust_qty', 'unit_cost', 'value', 'status', 'reason_code', 'memo'];
export function adjustmentRows(r) {
  return r.items.filter((i) => ADJUSTABLE.includes(i.status)).map((i) => ({ sku: i.sku, location: i.location, lot: i.lot || '', system_qty: i.system_qty, counted_qty: i.recount_qty ?? i.counted_qty, adjust_qty: i.variance_qty, unit_cost: i.unit_cost ?? '', value: i.variance_value ?? '', status: i.status, reason_code: '', memo: `Cycle count ${i.counted_at || ''}${i.status === 'confirmed_by_recount' ? ', confirmed by recount' : ''}` }));
}
export function reportMarkdown(r) {
  const L = ['# Cycle count variance review', '', `${r.lines} line(s): match ${r.match}, within tolerance ${r.within_tolerance}, timing ${r.explained_by_timing}, recount needed ${r.recount_needed}, confirmed by recount ${r.confirmed_by_recount}, investigate ${r.investigate}, not counted ${r.not_counted}.`, `Net variance ${r.net_variance_value.toFixed(2)}; absolute ${r.abs_variance_value.toFixed(2)} (value threshold ${r.value_threshold}).`, '', `> ${r.note}`, '', '| # | SKU | Location | System | Counted | Variance | Value | Status |', '|---|---|---|---|---|---|---|---|'];
  for (const i of r.items) L.push(`| ${i.rank} | ${i.sku}${i.lot ? ` (lot ${i.lot})` : ''} | ${i.location} | ${i.system_qty ?? '—'} | ${i.recount_qty ?? i.counted_qty ?? '—'} | ${i.variance_qty ?? '—'} | ${i.variance_value ?? '—'} | ${i.status}${i.flags.length ? ` (${i.flags.join(', ')})` : ''} |`);
  const n = r.items.filter((i) => i.notes.length); if (n.length) { L.push('', '## Notes', ''); for (const i of n) L.push(`- ${lineId(i)}: ${i.notes.join(' ')}`); }
  return L.join('\n') + '\n';
}

/** Blind recount sheet: the lines that need a recount or investigation, with no system quantity on it. */
export const RECOUNT_COLUMNS = ['sku', 'location', 'lot', 'description', 'uom', 'reason', 'counter', 'recount_qty', 'counted_at'];
export function recountCsv(r) {
  return toCsv(r.items.filter((i) => ['recount_needed', 'investigate'].includes(i.status) && !i.flags.includes('not_in_system')).map((i) => ({ sku: i.sku, location: i.location, lot: i.lot || '', description: i.description, uom: i.uom, reason: i.status === 'recount_needed' ? 'variance over tolerance' : i.flags.join('; '), counter: '', recount_qty: '', counted_at: '' })), RECOUNT_COLUMNS);
}
