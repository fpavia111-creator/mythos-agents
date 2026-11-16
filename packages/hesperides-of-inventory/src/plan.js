import { toNumber, round2, toCsv, toIcs } from 'mythos-agent-core';
import { pick } from './inventory.js';

const DAY = 86400000;
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const parseDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; };

/**
 * ABC classes by value. Value = annual_usage × unit_cost when the on-hand export has
 * annual_usage (units per year), otherwise on-hand value (system_qty × unit_cost, negatives as 0).
 * An item's class is the first class whose cumulative_share is above the share of value
 * ranked ahead of it, so the top item is always in the first class.
 */
export function abcClasses(onHand, policy) {
  const classes = [...policy.classes].sort((a, b) => a.cumulative_share - b.cumulative_share);
  const rows = [];
  for (const r of onHand) {
    const sku = pick(r, 'sku', 'item', 'item_id'); if (!sku) continue;
    const cost = toNumber(pick(r, 'unit_cost', 'cost', 'average_cost')) ?? 0; const usage = toNumber(pick(r, 'annual_usage', 'usage_per_year'));
    const qty = toNumber(pick(r, 'system_qty', 'on_hand', 'quantity', 'qty')) ?? 0;
    rows.push({ sku, location: pick(r, 'location', 'bin', 'warehouse'), lot: pick(r, 'lot', 'lot_number', 'batch', 'serial', 'serial_number'), description: pick(r, 'description', 'name'), uom: pick(r, 'uom', 'unit').toUpperCase(), basis: usage !== null ? 'annual_usage_value' : 'on_hand_value', value: round2(Math.max(0, (usage !== null ? usage : qty) * cost)) });
  }
  rows.sort((a, b) => b.value - a.value || a.sku.localeCompare(b.sku) || a.location.localeCompare(b.location) || a.lot.localeCompare(b.lot));
  const total = rows.reduce((t, r) => t + r.value, 0); let before = 0;
  for (const r of rows) {
    const ahead = total > 0 ? before / total : 1;
    r.share = total > 0 ? round2(r.value / total * 10000) / 10000 : 0; before += r.value; r.cumulative_share = total > 0 ? Math.round(before / total * 10000) / 10000 : 1;
    const c = classes.find((x) => ahead < x.cumulative_share) || classes[classes.length - 1];
    r.class = c.class; r.counts_per_year = c.counts_per_year; r.tolerance_pct = c.tolerance_pct;
  }
  return rows;
}

/**
 * A count schedule over `weeks` from `start_date`: each item is counted
 * ceil(counts_per_year × weeks / 52) times, evenly spaced, with items of a class
 * staggered so the work spreads across days. Deterministic for the same inputs.
 */
export function countPlan(onHand, policy) {
  const start = parseDate(policy.start_date); if (start === null) throw new Error('count policy start_date must be YYYY-MM-DD');
  const workdays = new Set((policy.working_days || ['mon', 'tue', 'wed', 'thu', 'fri']).map((d) => d.toLowerCase()));
  const days = [];
  for (let t = start; t < start + policy.weeks * 7 * DAY; t += DAY) if (workdays.has(DOW[new Date(t).getUTCDay()])) days.push(t);
  if (!days.length) throw new Error('count policy has no working days in the period');
  const items = abcClasses(onHand, policy);
  const byClass = new Map(); for (const i of items) byClass.set(i.class, [...(byClass.get(i.class) || []), i]);
  const lines = [];
  for (const [, list] of byClass) list.forEach((it, idx) => {
    const n = Math.max(1, Math.ceil(it.counts_per_year * policy.weeks / 52)); it.counts_in_period = n;
    const interval = days.length / n; const phase = (idx / list.length) * interval;
    for (let k = 0; k < n; k++) {
      const d = Math.min(days.length - 1, Math.floor(phase + k * interval));
      lines.push({ date: iso(days[d]), sku: it.sku, location: it.location, lot: it.lot, description: it.description, uom: it.uom, class: it.class, occurrence: `${k + 1}/${n}` });
    }
  });
  lines.sort((a, b) => a.date.localeCompare(b.date) || a.class.localeCompare(b.class) || a.location.localeCompare(b.location) || a.sku.localeCompare(b.sku));
  const perDay = new Map(); for (const l of lines) perDay.set(l.date, [...(perDay.get(l.date) || []), l]);
  const summary = [...new Set(items.map((i) => i.class))].sort().map((c) => {
    const its = items.filter((i) => i.class === c);
    return { class: c, items: its.length, value: round2(its.reduce((t, i) => t + i.value, 0)), counts_per_item: its[0].counts_in_period, count_lines: lines.filter((l) => l.class === c).length };
  });
  return {
    start_date: iso(start), end_date: iso(days[days.length - 1]), weeks: policy.weeks, working_days: days.length, items: items.length, count_lines: lines.length,
    max_lines_per_day: Math.max(...[...perDay.values()].map((x) => x.length)), classes: summary, abc: items, lines, per_day: [...perDay.entries()].map(([date, ls]) => ({ date, lines: ls.length })),
    blind: policy.blind !== false,
    note: 'A schedule for people to count. Count sheets are blind (no system quantity) unless the policy sets "blind": false.',
  };
}

export const ABC_COLUMNS = ['sku', 'location', 'lot', 'description', 'basis', 'value', 'share', 'cumulative_share', 'class', 'counts_in_period'];
export const PLAN_COLUMNS = ['date', 'class', 'sku', 'location', 'lot', 'description', 'uom', 'occurrence', 'counter', 'counted_qty', 'counted_at'];
export const planCsv = (p, onHand) => {
  const sys = new Map(onHand.map((r) => [`${pick(r, 'sku', 'item', 'item_id')}|${pick(r, 'location', 'bin', 'warehouse')}|${pick(r, 'lot', 'lot_number', 'batch', 'serial', 'serial_number')}`, pick(r, 'system_qty', 'on_hand', 'quantity', 'qty')]));
  const cols = p.blind ? PLAN_COLUMNS : [...PLAN_COLUMNS.slice(0, 8), 'system_qty', ...PLAN_COLUMNS.slice(8)];
  return toCsv(p.lines.map((l) => ({ ...l, system_qty: sys.get(`${l.sku}|${l.location}|${l.lot}`) ?? '', counter: '', counted_qty: '', counted_at: '' })), cols);
};
export const abcCsv = (p) => toCsv(p.abc, ABC_COLUMNS);
export function planIcs(p) {
  const days = new Map(); for (const l of p.lines) days.set(l.date, [...(days.get(l.date) || []), l]);
  const events = [...days.entries()].map(([date, ls]) => {
    const by = [...new Set(ls.map((l) => l.class))].sort().map((c) => `${c}: ${ls.filter((l) => l.class === c).length}`).join(', ');
    return { date, summary: `Cycle count: ${ls.length} line(s) (${by})`, description: ls.map((l) => `${l.sku} @ ${l.location}${l.lot ? ` lot ${l.lot}` : ''}`).join('\n'), categories: ['cycle-count'], reminders: [1] };
  });
  return toIcs(events, { calName: 'Cycle counts', prodId: '-//Mythos Machine//hesperides-of-inventory//EN' });
}

/**
 * Inventory record accuracy from a compare() result: share of counted lines whose final
 * count is within tolerance of the system (after timing), overall and by location, counter
 * and ABC class (class tolerances from the count policy when given). Value accuracy =
 * 1 - absolute variance value / system value of the counted lines.
 */
export function accuracy(r, classOf = null) {
  const counted = r.items.filter((i) => i.status !== 'not_counted' && !i.flags.includes('not_in_system') && !i.flags.includes('count_missing') && !i.flags.includes('uom_mismatch'));
  const hit = (i) => {
    const tol = classOf && classOf(i) && classOf(i).tolerance_pct !== undefined ? classOf(i).tolerance_pct : r.tolerance_pct;
    if ((i.variance_qty ?? 0) === 0) return true;
    const base = i.expected_at_count ?? i.system_qty;
    return (base ? Math.abs(i.variance_qty / base) <= tol + 1e-12 : false) || Math.abs(i.variance_qty) <= r.tolerance_units;
  };
  const stat = (list) => {
    const sysValue = list.reduce((t, i) => t + Math.abs((i.expected_at_count ?? i.system_qty ?? 0) * (i.unit_cost ?? 0)), 0);
    const absVar = list.reduce((t, i) => t + Math.abs(i.variance_value ?? 0), 0);
    return { lines: list.length, hits: list.filter(hit).length, ira_pct: list.length ? round2(list.filter(hit).length / list.length * 100) : null, value_accuracy_pct: sysValue > 0 ? round2(Math.max(0, 1 - absVar / sysValue) * 100) : null, abs_variance_value: round2(absVar) };
  };
  const group = (f) => { const m = new Map(); for (const i of counted) { const k = f(i) || '(none)'; m.set(k, [...(m.get(k) || []), i]); } return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, l]) => ({ key: k, ...stat(l), misses: l.filter((i) => !hit(i)).map((i) => `${i.sku}@${i.location}${i.lot ? `#${i.lot}` : ''}`) })); };
  return {
    overall: stat(counted), by_location: group((i) => i.location), by_counter: group((i) => i.counter), by_class: classOf ? group((i) => (classOf(i) || {}).class) : [],
    not_scored: r.items.length - counted.length,
  };
}
