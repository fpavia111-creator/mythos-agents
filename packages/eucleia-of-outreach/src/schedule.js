import { toCsv, toIcs } from 'mythos-agent-core';
import { checkDraft, inWindow, localParts, DEFAULTS } from './gate.js';

/**
 * Plan send slots for the drafts that pass every check (the existing send_at is ignored):
 * each slot is inside the window in the recipient's time zone (or the config's), no more
 * than max_per_day per sender-local day, and at least min_gap_minutes apart.
 * Deterministic: the same drafts, config and start_from always give the same plan.
 */
export function planSchedule(drafts, { suppression, config = {}, start_from, max_per_day, min_gap_minutes, horizon_days = 60 }) {
  const cfg = { ...DEFAULTS, ...config };
  const perDay = Number(max_per_day ?? cfg.max_per_day), gap = Number(min_gap_minutes ?? cfg.min_gap_minutes);
  const start = Date.parse(start_from);
  if (!Number.isFinite(start)) throw new Error('start_from must be an ISO date-time');
  if (!Number.isInteger(gap) || gap < 1 || gap > 1440) throw new Error('min_gap_minutes must be a whole number from 1 to 1440 (one day)');
  if (!Number.isInteger(perDay) || perDay < 1 || perDay > 100000) throw new Error('max_per_day must be a whole number from 1 to 100000');
  if (!Number.isFinite(horizon_days) || horizon_days < 1 || horizon_days > 366) throw new Error('horizon_days must be from 1 to 366');
  const seen = new Set();
  const checked = drafts.map((d, i) => {
    const { send_at, ...rest } = d;
    const r = checkDraft(rest, { suppression, config: cfg });
    const k = String(d.to || '').trim().toLowerCase();
    if (k && seen.has(k)) { r.ok = false; r.fails.push('duplicate: this address already has a draft in this batch'); }
    seen.add(k);
    return { row: i + 2, d, r };
  });
  const step = Math.max(1, gap) * 60000;
  const counts = new Map(); const slots = []; const unplaced = [];
  const used = []; // minute indexes already taken
  // The latest taken minute closer than the gap to minute m, or null when m is free.
  // `used` is kept sorted, so this is a binary search for the largest x below m + gap.
  const blocker = (m) => { let lo = 0, hi = used.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (used[mid] < m + gap) lo = mid + 1; else hi = mid; } const x = lo ? used[lo - 1] : null; return x !== null && Math.abs(x - m) < gap ? x : null; };
  const take = (m) => { let lo = 0, hi = used.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (used[mid] < m) lo = mid + 1; else hi = mid; } used.splice(lo, 0, m); };
  const startMin = Math.ceil(start / 60000) * 60000; const end = start + horizon_days * 86400000;
  const pointer = new Map(); // per time zone: where the next search starts
  // A search that found no slot gives the same answer again until something is placed.
  const failed = new Map();
  for (const c of checked.filter((x) => x.r.ok)) {
    const tz = c.r.time_zone;
    let placed = false;
    const from = pointer.get(tz) ?? startMin; const f = failed.get(tz);
    if (f && f.from === from && f.placed === slots.length) { unplaced.push({ row: c.row, to: c.d.to, reason: `no slot within ${horizon_days} days` }); continue; }
    for (let u = pointer.get(tz) ?? startMin; u <= end; u += 60000) {
      const w = inWindow(new Date(u).toISOString(), cfg, tz);
      if (!w.ok) { u += 14 * 60000 - ((u / 60000) % 15) * 60000; continue; } // windows open on the quarter hour
      const b = blocker(u / 60000);
      if (b !== null) { u = (b + gap - 1) * 60000; continue; } // jump past the gap instead of stepping minute by minute
      const day = localParts(new Date(u).toISOString(), cfg.time_zone).date;
      if ((counts.get(day) || 0) >= perDay) continue;
      counts.set(day, (counts.get(day) || 0) + 1); take(u / 60000);
      slots.push({ row: c.row, to: c.d.to, subject: c.d.subject, send_at: new Date(u).toISOString(), local: w.local, sender_day: day });
      pointer.set(tz, u + step); placed = true; break;
    }
    if (!placed) { failed.set(tz, { from, placed: slots.length }); unplaced.push({ row: c.row, to: c.d.to, reason: `no slot within ${horizon_days} days` }); }
  }
  slots.sort((x, y) => (x.send_at < y.send_at ? -1 : x.send_at > y.send_at ? 1 : x.row - y.row));
  const held = checked.filter((x) => !x.r.ok).map((x) => ({ row: x.row, to: x.d.to, reasons: x.r.fails }));
  const days = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, n]) => ({ date, count: n, first: slots.find((s) => s.sender_day === date).local, last: [...slots].reverse().find((s) => s.sender_day === date).local }));
  return { start_from: new Date(start).toISOString(), max_per_day: perDay, min_gap_minutes: gap, scheduled: slots.length, held: held.length, unplaced: unplaced.length, slots, days, held_rows: held, unplaced_rows: unplaced, note: 'A plan for the person who sends. Eucleia sends nothing.' };
}

export const scheduleCsv = (p) => toCsv(p.slots, ['row', 'to', 'subject', 'send_at', 'local', 'sender_day']);
/** One all-day calendar entry per sending day (count and first/last slot; no addresses). */
export const scheduleIcs = (p) => toIcs(p.days.map((d) => ({ date: d.date, summary: `Outreach: send ${d.count} reviewed draft(s)`, description: `First slot ${d.first}; last slot ${d.last}. Send from your own mail tool. Eucleia sends nothing.`, reminders: [0], uid: `eucleia-${d.date}@mythos.local` })), { calName: 'Outreach send plan' });
