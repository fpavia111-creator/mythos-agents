import { escapeHtml } from 'mythos-agent-core';

// Self-contained SVG charts drawn only from locked figures. No scripts, no event handlers,
// no external references. Every drawn point is a <rect class="point"> carrying
// data-figure-id, data-field and data-value, so each mark traces to one figure id.

export const CHARTS = Object.freeze({
  variance: { title: 'Variance against basis', unit: 'amount' },
  variance_pct: { title: 'Variance against basis (%)', unit: 'percent' },
  actual_vs_basis: { title: 'Actual against budget (or prior period)', unit: 'amount' },
});

const W = 680, LABEL = 190, VALUE = 110, ROW = 30, TOP = 56, BOTTOM = 34;
// The value column is as wide as its longest label (about 7px a character at 12px),
// so a large number never runs into the bars; the plot takes what is left.
const layout = (labels) => { const value = Math.min(260, Math.max(VALUE, ...labels.map((l) => Math.ceil(l.length * 7) + 8))); return { value, plot: W - LABEL - value - 16 }; };
const COLORS = { pos: '#2563eb', neg: '#c2410c', actual: '#2563eb', basis: '#94a3b8', axis: '#64748b', text: '#1f2937', mut: '#6b7280' };
const fmtN = (n) => Math.round(n).toLocaleString('en-US');
const sgn = (n) => (n > 0 ? '+' : n < 0 ? '−' : '');
const fmtSigned = (n, pct) => `${sgn(n)}${pct ? Math.abs(n).toFixed(1) + '%' : fmtN(Math.abs(n))}`;
const num = (n) => String(Math.round(n * 100) / 100);
const x2 = (n) => (Math.round(n * 10) / 10).toFixed(1);

function frame(title, desc, height, body) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-labelledby="chart-title chart-desc" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="12">`,
    `<title id="chart-title">${escapeHtml(title)}</title>`,
    `<desc id="chart-desc">${escapeHtml(desc)}</desc>`,
    `<rect x="0" y="0" width="${W}" height="${height}" fill="#ffffff"/>`,
    `<text x="12" y="22" font-size="15" font-weight="600" fill="${COLORS.text}">${escapeHtml(title)}</text>`,
    `<text x="12" y="40" fill="${COLORS.mut}">${escapeHtml(desc)}</text>`,
    ...body,
    '</svg>',
    '',
  ].join('\n');
}

function point({ id, field, value, x, y, w, h, fill, label }) {
  return `<rect class="point" data-figure-id="${escapeHtml(id)}" data-field="${field}" data-value="${num(value)}" x="${x2(x)}" y="${x2(y)}" width="${x2(Math.max(w, 0.5))}" height="${x2(h)}" fill="${fill}"><title>${escapeHtml(label)}</title></rect>`;
}

/** Diverging bar chart of each figure's variance against its basis (budget, else prior). */
function varianceChart(vs, pct, source) {
  const rows = vs.filter((v) => v.basis && (pct ? (v.basis === 'budget' ? v.var_budget_pct : v.var_prior_pct) !== null : true));
  const field = (v) => (v.basis === 'budget' ? (pct ? 'var_budget_pct' : 'var_budget') : pct ? 'var_prior_pct' : 'var_prior');
  const max = Math.max(1e-9, ...rows.map((v) => Math.abs(v[field(v)])));
  const right = (v) => `${fmtSigned(v[field(v)], pct)} vs ${v.basis === 'budget' ? 'budget' : 'prior'}${v.material ? ' *' : ''}`;
  const { plot } = layout(rows.map(right));
  const zero = LABEL + plot / 2; const half = plot / 2 - 4;
  const height = TOP + rows.length * ROW + BOTTOM;
  const body = [`<line x1="${zero}" y1="${TOP - 6}" x2="${zero}" y2="${TOP + rows.length * ROW}" stroke="${COLORS.axis}" stroke-width="1"/>`];
  rows.forEach((v, i) => {
    const val = v[field(v)]; const y = TOP + i * ROW; const w = (Math.abs(val) / max) * half;
    const x = val >= 0 ? zero : zero - w;
    const label = `${v.id} ${v.metric}: vs ${v.basis} ${fmtSigned(val, pct)}${v.material ? ' (material)' : ''}`;
    body.push(`<text x="12" y="${y + 18}" fill="${COLORS.text}">${escapeHtml(`${v.id} · ${v.metric}`.slice(0, 30))}</text>`);
    body.push(point({ id: v.id, field: field(v), value: val, x, y: y + 6, w, h: ROW - 12, fill: val >= 0 ? COLORS.pos : COLORS.neg, label }));
    body.push(`<text x="${W - 12}" y="${y + 18}" text-anchor="end" fill="${COLORS.text}">${escapeHtml(right(v))}</text>`);
  });
  body.push(`<text x="12" y="${height - 12}" fill="${COLORS.mut}">${escapeHtml(`* material. Bars right of the line: actual above basis. Source: ${source}`)}</text>`);
  return { height, body, rows };
}

/** Paired bars: actual and its basis on one shared scale. */
function actualVsBasisChart(vs, source) {
  const rows = vs.filter((v) => v.basis);
  const basisField = (v) => (v.basis === 'budget' ? 'budget' : 'prior');
  const max = Math.max(1e-9, ...rows.flatMap((v) => [Math.abs(v.actual), Math.abs(v[basisField(v)])]));
  const RH = 40; const height = TOP + rows.length * RH + BOTTOM;
  const basisLabel = (v) => `${fmtN(v[basisField(v)])} ${basisField(v) === 'budget' ? 'budget' : 'prior'}`;
  const { plot: PLOT } = layout(rows.flatMap((v) => [fmtN(v.actual), basisLabel(v)]));
  const body = [`<line x1="${LABEL}" y1="${TOP - 6}" x2="${LABEL}" y2="${TOP + rows.length * RH}" stroke="${COLORS.axis}" stroke-width="1"/>`];
  rows.forEach((v, i) => {
    const y = TOP + i * RH; const bf = basisField(v);
    body.push(`<text x="12" y="${y + 20}" fill="${COLORS.text}">${escapeHtml(`${v.id} · ${v.metric}`.slice(0, 30))}</text>`);
    body.push(point({ id: v.id, field: 'actual', value: v.actual, x: LABEL, y: y + 4, w: (Math.abs(v.actual) / max) * PLOT, h: 14, fill: COLORS.actual, label: `${v.id} ${v.metric}: actual ${fmtN(v.actual)}` }));
    body.push(point({ id: v.id, field: bf, value: v[bf], x: LABEL, y: y + 20, w: (Math.abs(v[bf]) / max) * PLOT, h: 14, fill: COLORS.basis, label: `${v.id} ${v.metric}: ${bf} ${fmtN(v[bf])}` }));
    body.push(`<text x="${W - 12}" y="${y + 15}" text-anchor="end" fill="${COLORS.text}">${fmtN(v.actual)}</text>`);
    body.push(`<text x="${W - 12}" y="${y + 31}" text-anchor="end" fill="${COLORS.mut}">${escapeHtml(basisLabel(v))}</text>`);
  });
  body.push(`<text x="12" y="${height - 12}" fill="${COLORS.mut}">${escapeHtml(`Blue: actual. Grey: budget, or prior period when there is no budget. Shared scale. Source: ${source}`)}</text>`);
  return { height, body, rows };
}

/** Build one chart. Returns { svg, points } where every point names its figure id, field and value. */
export function chartSvg(vs, chart, { source = 'locked figures', ids = null } = {}) {
  if (!CHARTS[chart]) throw new Error(`unknown chart "${chart}"`);
  const pick = ids && ids.length ? vs.filter((v) => ids.includes(v.id)) : vs;
  if (ids) for (const id of ids) if (!vs.some((v) => v.id === id)) throw new Error(`unknown figure id ${id}`);
  const built = chart === 'actual_vs_basis' ? actualVsBasisChart(pick, source) : varianceChart(pick, chart === 'variance_pct', source);
  const svg = frame(CHARTS[chart].title, `${built.rows.length} figure(s) from ${source}. Each bar is labelled with its figure id.`, built.height, built.body);
  const issues = svgSafety(svg); if (issues.length) throw new Error(`chart failed its safety check: ${issues.join('; ')}`);
  return { chart, svg, points: svgPoints(svg) };
}

/** Every data point in an SVG made by chartSvg. */
export function svgPoints(svg) {
  return [...String(svg).matchAll(/<rect class="point" data-figure-id="([^"]*)" data-field="([^"]*)" data-value="([^"]*)"/g)].map((m) => ({ figure_id: m[1].replace(/&amp;/g, '&'), field: m[2], value: Number(m[3]) }));
}

/** Reasons an SVG is not self-contained and script-free ([] when it is). */
export function svgSafety(svg) {
  const s = String(svg); const out = [];
  if (/<script/i.test(s)) out.push('contains <script>');
  if (/\son[a-z]+\s*=/i.test(s)) out.push('contains an event handler attribute');
  if (/<foreignObject/i.test(s)) out.push('contains <foreignObject>');
  if (/(?:xlink:)?href\s*=/i.test(s)) out.push('contains a link or external reference');
  if (/url\(|@import|javascript:/i.test(s)) out.push('contains an external url');
  if (/<image|<use\b/i.test(s)) out.push('contains an image or use element');
  return out;
}

/** Check that every point traces to a figure id and equals that figure's field. */
export function tracePoints(points, vs) {
  const byId = new Map(vs.map((v) => [v.id, v])); const bad = [];
  for (const p of points) {
    const v = byId.get(p.figure_id);
    if (!v) bad.push(`${p.figure_id}: unknown figure id`);
    else if (v[p.field] === null || v[p.field] === undefined || Math.abs(Number(v[p.field]) - p.value) > 0.005) bad.push(`${p.figure_id}.${p.field}: ${p.value} does not equal the figure`);
  }
  return bad;
}
