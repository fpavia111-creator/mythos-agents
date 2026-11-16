import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Step and spend counters that survive a restart.
 * Stored in <stateDir>/usage.json:
 *   { days: { "2026-11-15": { steps, spend_usd, tools: { name: { steps, spend_usd } } } },
 *     sessions: { "<id>": { steps, spend_usd, tools: {...}, updated } } }
 * Only the last 31 days and 200 sessions are kept.
 */
export class UsageStore {
  constructor(dir) { this.file = dir ? join(dir, 'usage.json') : null; this.mem = { days: {}, sessions: {} }; }

  read() {
    if (!this.file) return this.mem;
    if (!existsSync(this.file)) return { days: {}, sessions: {} };
    try { const d = JSON.parse(readFileSync(this.file, 'utf8')); return { days: d.days || {}, sessions: d.sessions || {} }; }
    catch { return { days: {}, sessions: {} }; }
  }

  #save(d) {
    const days = Object.keys(d.days).sort().slice(-31);
    d.days = Object.fromEntries(days.map((k) => [k, d.days[k]]));
    const sess = Object.entries(d.sessions).sort((a, b) => String(a[1].updated).localeCompare(String(b[1].updated))).slice(-200);
    d.sessions = Object.fromEntries(sess);
    if (!this.file) { this.mem = d; return; }
    mkdirSync(join(this.file, '..'), { recursive: true });
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(d, null, 2));
    renameSync(tmp, this.file);
  }

  /** Usage snapshot for a session and day. */
  get(session, day = new Date().toISOString().slice(0, 10)) {
    const d = this.read();
    const blank = () => ({ steps: 0, spend_usd: 0, tools: {} });
    return { day, today: d.days[day] || blank(), session: d.sessions[session] || blank() };
  }

  add(session, tool, steps, spendUsd, day = new Date().toISOString().slice(0, 10)) {
    const d = this.read();
    const bump = (o) => {
      o.steps += steps; o.spend_usd = Math.round((o.spend_usd + spendUsd) * 1e6) / 1e6;
      const t = o.tools[tool] || (o.tools[tool] = { steps: 0, spend_usd: 0 });
      t.steps += steps; t.spend_usd = Math.round((t.spend_usd + spendUsd) * 1e6) / 1e6;
    };
    const day0 = d.days[day] || (d.days[day] = { steps: 0, spend_usd: 0, tools: {} });
    const s0 = d.sessions[session] || (d.sessions[session] = { steps: 0, spend_usd: 0, tools: {} });
    bump(day0); bump(s0); s0.updated = new Date().toISOString();
    this.#save(d);
  }
}

/**
 * Check caps before a call. caps: { maxSteps, maxSpendUsd, maxStepsPerDay,
 * maxSpendUsdPerDay, perTool: { name: { maxSteps, maxSpendUsd, maxStepsPerDay } } }.
 * Returns null when within caps, else { cap, limit, used, scope, reason }.
 */
export function capHit(caps, usage, tool, cost) {
  const s = usage.session; const d = usage.today;
  const checks = [
    ['maxSteps', 'session', s.steps + 1, caps.maxSteps, 'step cap'],
    ['maxSpendUsd', 'session', s.spend_usd + cost, caps.maxSpendUsd, 'spend cap'],
    ['maxStepsPerDay', 'day', d.steps + 1, caps.maxStepsPerDay, 'daily step cap'],
    ['maxSpendUsdPerDay', 'day', d.spend_usd + cost, caps.maxSpendUsdPerDay, 'daily spend cap'],
  ];
  const pt = caps.perTool && caps.perTool[tool];
  if (pt) {
    const st = s.tools[tool] || { steps: 0, spend_usd: 0 }; const dt = d.tools[tool] || { steps: 0, spend_usd: 0 };
    checks.push(['perTool.maxSteps', 'session', st.steps + 1, pt.maxSteps, `step cap for ${tool}`]);
    checks.push(['perTool.maxSpendUsd', 'session', st.spend_usd + cost, pt.maxSpendUsd, `spend cap for ${tool}`]);
    checks.push(['perTool.maxStepsPerDay', 'day', dt.steps + 1, pt.maxStepsPerDay, `daily step cap for ${tool}`]);
  }
  for (const [cap, scope, next, limit, label] of checks) {
    if (limit === undefined || limit === null || !Number.isFinite(Number(limit))) continue;
    const isSpend = /Spend/.test(cap);
    // Spend caps of 0 mean "no paid calls"; a free (0-cost) call still runs.
    if (isSpend ? next > Number(limit) + 1e-9 : next > Number(limit)) {
      return { cap, scope, limit: Number(limit), used: isSpend ? Math.round((next - cost) * 1e6) / 1e6 : next - 1, reason: `${label} reached (${isSpend ? '$' : ''}${limit}${scope === 'day' ? ' per day' : ''})` };
    }
  }
  return null;
}
