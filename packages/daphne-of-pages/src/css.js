// Minimal, dependency-free CSS reading for the contrast and focus checks: style blocks,
// local stylesheets and inline styles; simple selectors (type, .class, #id, [attr], *)
// with descendant and child combinators. Rules with pseudo-classes or pseudo-elements are
// kept aside for the focus-indicator check and never used for colour.

const NAMED = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080',
  silver: '#c0c0c0', maroon: '#800000', navy: '#000080', olive: '#808000', purple: '#800080', teal: '#008080', orange: '#ffa500', lime: '#00ff00',
  aqua: '#00ffff', fuchsia: '#ff00ff', lightgray: '#d3d3d3', lightgrey: '#d3d3d3', darkgray: '#a9a9a9', darkgrey: '#a9a9a9', gainsboro: '#dcdcdc',
  whitesmoke: '#f5f5f5', lightyellow: '#ffffe0', beige: '#f5f5dc', ivory: '#fffff0', pink: '#ffc0cb', gold: '#ffd700', khaki: '#f0e68c',
};

/** Parse a CSS colour into { r, g, b, a } (0-255, alpha 0-1), or null when unknown (var(), currentColor, gradients…). */
export function parseColor(v) {
  let s = String(v || '').trim().toLowerCase().replace(/\s*!important$/, '');
  if (!s) return null;
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (NAMED[s]) s = NAMED[s];
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const ch = (x) => (x.endsWith('%') ? (parseFloat(x) * 255) / 100 : parseFloat(x));
    const al = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: ch(m[1]), g: ch(m[2]), b: ch(m[3]), a: al };
  }
  return null;
}
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
export const luminance = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
/** WCAG contrast ratio of two opaque colours. */
export function contrastRatio(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
export const hex = ({ r, g, b }) => '#' + [r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('');

export function parseDecls(text) {
  const out = {};
  for (const part of String(text || '').split(';')) {
    const i = part.indexOf(':'); if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase(); const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** Parse a stylesheet into rules [{ selector, decls, order, pseudo, media }]. @media blocks are read (their rules apply); other at-rules are skipped. */
export function parseCss(css, startOrder = 0) {
  const src = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = []; let order = startOrder;
  const walk = (text, media) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i); if (open < 0) break;
      const head = text.slice(i, open).trim();
      // find the matching close brace
      let depth = 1, j = open + 1;
      while (j < text.length && depth) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith('@media')) walk(body, head);
      else if (!head.startsWith('@')) {
        const decls = parseDecls(body);
        for (const sel of head.split(',').map((x) => x.trim()).filter(Boolean)) rules.push({ selector: sel, decls, order: order++, pseudo: /:/.test(sel.replace(/\[[^\]]*\]/g, '')), media: media || '' });
      }
      i = j;
    }
  };
  walk(src, '');
  return rules;
}

function parseCompound(s) {
  const c = { tag: null, id: null, classes: [], attrs: [] };
  const re = /(^[a-z][a-z0-9-]*|\*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([~|^$*]?=)["']?([^"'\]]*)["']?)?\]/gi;
  let m; let consumed = 0;
  while ((m = re.exec(s))) {
    if (m.index !== consumed) return null;
    consumed = re.lastIndex;
    if (m[1]) c.tag = m[1] === '*' ? null : m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push({ name: m[4].toLowerCase(), op: m[5] || '', value: m[6] || '' });
  }
  return consumed === s.length ? c : null;
}
/** Parse a selector into compound parts with combinators; null for anything unsupported. */
export function parseSelector(sel) {
  const tokens = String(sel).trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
  const parts = []; let comb = ' ';
  for (const t of tokens) {
    if (t === '>') { comb = '>'; continue; }
    if (t === '+' || t === '~') return null;
    const c = parseCompound(t); if (!c) return null;
    parts.push({ ...c, comb }); comb = ' ';
  }
  return parts.length ? parts : null;
}
export function specificity(parts) {
  let a = 0, b = 0, c = 0;
  for (const p of parts) { if (p.id) a++; b += p.classes.length + p.attrs.length; if (p.tag) c++; }
  return a * 10000 + b * 100 + c;
}
const NO_CLASSES = Object.freeze([]);
const classCache = new WeakMap();
function classesOf(el) {
  const raw = el.attrs && el.attrs.class; if (!raw) return NO_CLASSES;
  let c = classCache.get(el); if (!c) { c = String(raw).split(/\s+/).filter(Boolean); classCache.set(el, c); }
  return c;
}
function matchCompound(el, c) {
  if (!el || !el.attrs || el.name === '#root') return false;
  if (c.tag && el.name !== c.tag) return false;
  if (c.id && el.attrs.id !== c.id) return false;
  if (c.classes.length) { const cls = classesOf(el); for (const x of c.classes) if (!cls.includes(x)) return false; }
  for (const at of c.attrs) {
    if (!(at.name in el.attrs)) return false;
    const v = el.attrs[at.name];
    if (at.op === '=' && v !== at.value) return false;
    if (at.op === '~=' && !v.split(/\s+/).includes(at.value)) return false;
    if (at.op === '^=' && !v.startsWith(at.value)) return false;
    if (at.op === '$=' && !v.endsWith(at.value)) return false;
    if (at.op === '*=' && !v.includes(at.value)) return false;
  }
  return true;
}
export function matches(el, parts) {
  const last = parts.length - 1;
  if (!matchCompound(el, parts[last])) return false;
  let cur = el;
  for (let i = last - 1; i >= 0; i--) {
    const comb = parts[i + 1].comb;
    if (comb === '>') { cur = cur.parent; if (!matchCompound(cur, parts[i])) return false; }
    else { let p = cur.parent; while (p && !matchCompound(p, parts[i])) p = p.parent; if (!p) return false; cur = p; }
  }
  return true;
}

/** A stable, readable CSS selector for an element (stops at the nearest id). */
export function cssPath(el) {
  const segs = [];
  for (let e = el; e && e.name && e.name !== '#root'; e = e.parent) {
    if (e.attrs.id && /^[A-Za-z][\w-]*$/.test(e.attrs.id)) { segs.unshift(`${e.name}#${e.attrs.id}`); break; }
    let seg = e.name + classesOf(e).filter((c) => /^[A-Za-z_-][\w-]*$/.test(c)).map((c) => '.' + c).join('');
    const sig = (x) => `${x.name}|${classesOf(x).join('.')}`;
    const sibs = (e.parent && e.parent.children || []).filter((x) => x.name && sig(x) === sig(e));
    if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(e) + 1})`;
    segs.unshift(seg);
    if (e.name === 'body' || e.name === 'html') break;
  }
  return segs.join(' > ');
}

/** Cascade for one element: the winning declared value of each property among normal (non-pseudo) rules and the inline style. */
export function cascade(el, rules) {
  // Precedence: !important, then inline style, then specificity, then source order.
  const won = {};
  const beats = (a, b) => { for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] > b[i]; return true; };
  const apply = (decls, inline, spec, order) => {
    for (const [k, v] of Object.entries(decls)) {
      const w = [/!important\s*$/i.test(v) ? 1 : 0, inline, spec, order];
      if (!won[k] || beats(w, won[k].w)) won[k] = { v: v.replace(/\s*!important\s*$/i, ''), w };
    }
  };
  for (const r of candidatesFor(el, rules)) { if (r.pseudo || /print/.test(r.media)) continue; if (r.parts && matches(el, r.parts)) apply(r.decls, 0, r.spec, r.order); }
  if (el.attrs && el.attrs.style) apply(parseDecls(el.attrs.style), 1, 0, 0);
  return Object.fromEntries(Object.entries(won).map(([k, x]) => [k, x.v]));
}
/**
 * Parse selectors once and index rules by the key of their rightmost compound (id, first class, tag),
 * so an element is only tested against rules that could match it.
 */
export function prepareRules(rules) {
  const idx = { id: new Map(), cls: new Map(), tag: new Map(), any: [] };
  const put = (m, k, r) => { if (!m.has(k)) m.set(k, []); m.get(k).push(r); };
  for (const r of rules) {
    r.parts = r.pseudo ? null : parseSelector(r.selector);
    if (!r.parts) continue;
    r.spec = specificity(r.parts);
    const last = r.parts[r.parts.length - 1];
    if (last.id) put(idx.id, last.id, r); else if (last.classes.length) put(idx.cls, last.classes[0], r); else if (last.tag) put(idx.tag, last.tag, r); else idx.any.push(r);
  }
  Object.defineProperty(rules, 'index', { value: idx, enumerable: false });
  return rules;
}
function candidatesFor(el, rules) {
  const idx = rules.index; if (!idx) return rules;
  const out = [...idx.any, ...(idx.tag.get(el.name) || [])];
  if (el.attrs && el.attrs.id) out.push(...(idx.id.get(el.attrs.id) || []));
  for (const c of classesOf(el)) out.push(...(idx.cls.get(c) || []));
  return out;
}

const UA_SIZE = { h1: 32, h2: 24, h3: 18.72, h4: 16, h5: 13.28, h6: 10.72 };
const BOLD_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'b', 'strong', 'th']);
function px(v, parentPx) {
  const m = /^([\d.]+)(px|pt|em|rem|%)?$/.exec(String(v || '').trim()); if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'pt' ? (n * 4) / 3 : m[2] === 'em' ? n * parentPx : m[2] === 'rem' ? n * 16 : m[2] === '%' ? (n / 100) * parentPx : n;
}
const bgColorOf = (d) => {
  if (d['background-image'] && d['background-image'] !== 'none') return 'image';
  if (d['background-color']) return parseColor(d['background-color']);
  if (d.background) { if (/url\(|gradient\(/i.test(d.background)) return 'image'; const tok = d.background.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b[a-z]+\b/gi) || []; for (const t of tok) { const c = parseColor(t); if (c) return c; } }
  return undefined;
};

/**
 * Computed text colour, background, size and weight for an element, or { unknown: reason } when a value
 * cannot be read statically (variables, images or gradients behind text, semi-transparent layers).
 */
export function computedStyle(el, rules, memo = new Map()) {
  if (!el || el.name === '#root') return { color: { r: 0, g: 0, b: 0, a: 1 }, bg: { r: 255, g: 255, b: 255, a: 1 }, size: 16, bold: false, bgFrom: null, colorFrom: null };
  if (memo.has(el)) return memo.get(el);
  const parent = computedStyle(el.parent, rules, memo); const d = cascade(el, rules);
  let color = parent.color, colorFrom = parent.colorFrom, unknown = parent.unknown;
  if (d.color !== undefined) { const c = parseColor(d.color); if (!c || c.a < 1) unknown = unknown || `text colour "${d.color}" cannot be read statically`; else { color = c; colorFrom = 'css'; } }
  let bg = parent.bg, bgFrom = parent.bgFrom;
  const b = bgColorOf(d);
  if (b === 'image') unknown = unknown || 'a background image or gradient sits behind the text';
  else if (b === null) unknown = unknown || 'background colour cannot be read statically';
  else if (b && b.a > 0) { if (b.a < 1) unknown = unknown || 'semi-transparent background'; else { bg = b; bgFrom = 'css'; } }
  let size = d['font-size'] !== undefined ? px(d['font-size'], parent.size) : UA_SIZE[el.name] ?? parent.size;
  if (size === null) size = parent.size;
  const fw = d['font-weight']; const bold = fw !== undefined ? /bold|bolder|[6-9]00/.test(fw) : BOLD_TAGS.has(el.name) || parent.bold;
  const out = { color, bg, size, bold, bgFrom, colorFrom, unknown };
  memo.set(el, out); return out;
}
/** Large text per WCAG: at least 24px, or at least 18.66px (14pt) and bold. */
export const isLarge = (s) => s.size >= 24 || (s.bold && s.size >= 18.66);

/** Rules that remove the focus outline without giving a replacement indicator in the same rule. */
export function focusOutlineRemovals(rules) {
  const out = [];
  for (const r of rules) {
    if (!/:focus\b|:focus-visible\b|:focus-within\b/.test(r.selector) && !/^\*$|^a$|^button$|^:root/.test(r.selector)) continue;
    const ol = r.decls.outline ?? r.decls['outline-style'] ?? r.decls['outline-width'];
    if (ol === undefined || !/^(none|0|0px)(\s|$)/i.test(String(ol).trim())) continue;
    const repl = ['box-shadow', 'border', 'border-color', 'border-bottom', 'text-decoration', 'background', 'background-color'].some((k) => r.decls[k] && !/^none$/i.test(r.decls[k]));
    if (repl) continue;
    // A separate :focus-visible rule with an outline or box-shadow counts as the replacement.
    const base = r.selector.replace(/:focus(-visible|-within)?/g, '');
    const visible = rules.some((x) => x !== r && /:focus-visible/.test(x.selector) && x.selector.replace(/:focus-visible/g, '') === base && ((x.decls.outline && !/^(none|0)/i.test(x.decls.outline)) || x.decls['box-shadow']));
    if (!visible) out.push(r);
  }
  return out;
}
