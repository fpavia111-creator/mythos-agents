// A small YAML reader for the subset Kubernetes manifests use: block mappings and
// sequences, plain/quoted scalars, flow [..] and {..} on one line, literal/folded block
// scalars, comments and multiple documents (---). Anchors, aliases, tags and complex
// keys are refused with a clear error rather than guessed. Zero dependencies.

export class YamlError extends Error {}

function stripComment(t) {
  let q = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === q) { if (q === "'" && t[i + 1] === "'") { i++; continue; } q = null; } else if (c === '\\' && q === '"') i++; continue; }
    if (c === '"' || c === "'") { if (i === 0 || /[\s:[{,-]/.test(t[i - 1])) q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(t[i - 1]))) return t.slice(0, i).trimEnd();
  }
  return t.trimEnd();
}

const KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s'"#\-?:,[\]{}&*!|>%@`][^:#]*?|-[^\s:][^:#]*?)\s*:(?:\s+|$)/;

function scalar(raw, line) {
  const t = raw.trim();
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (t[0] === '"') { const m = /^"((?:[^"\\]|\\.)*)"$/.exec(t); if (!m) throw new YamlError(`line ${line}: unterminated double-quoted string`); return JSON.parse(`"${m[1].replace(/\\'/g, "'").replace(/\\\//g, '/')}"`); }
  if (t[0] === "'") { const m = /^'((?:[^']|'')*)'$/.exec(t); if (!m) throw new YamlError(`line ${line}: unterminated single-quoted string`); return m[1].replace(/''/g, "'"); }
  if (/^[&*!]/.test(t)) throw new YamlError(`line ${line}: anchors, aliases and tags are not supported`);
  if (t[0] === '[' || t[0] === '{') return flow(t, line);
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^[-+]?(0|[1-9]\d*)$/.test(t)) return Number(t);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (/^0x[0-9a-fA-F]+$/.test(t)) return parseInt(t, 16);
  return t;
}

function flow(t, line) {
  let i = 0;
  const ws = () => { while (i < t.length && /\s/.test(t[i])) i++; };
  const val = () => {
    ws();
    if (t[i] === '[') { i++; const a = []; ws(); if (t[i] === ']') { i++; return a; } for (;;) { a.push(val()); ws(); if (t[i] === ',') { i++; ws(); if (t[i] === ']') { i++; return a; } continue; } if (t[i] === ']') { i++; return a; } throw new YamlError(`line ${line}: bad flow sequence`); } }
    if (t[i] === '{') { i++; const o = {}; ws(); if (t[i] === '}') { i++; return o; } for (;;) { ws(); const k = atom(true); ws(); if (t[i] !== ':') throw new YamlError(`line ${line}: bad flow mapping`); i++; o[k] = val(); ws(); if (t[i] === ',') { i++; ws(); if (t[i] === '}') { i++; return o; } continue; } if (t[i] === '}') { i++; return o; } throw new YamlError(`line ${line}: bad flow mapping`); } }
    return atom(false);
  };
  const atom = (isKey) => {
    ws(); const s = i;
    if (t[i] === '"' || t[i] === "'") { const q = t[i]; i++; while (i < t.length && t[i] !== q) { if (t[i] === '\\' && q === '"') i++; i++; } i++; const raw = t.slice(s, i); return isKey ? scalar(raw, line) + '' : scalar(raw, line); }
    while (i < t.length && !(isKey ? /[:,}\]]/ : /[,}\]]/).test(t[i])) i++;
    const raw = t.slice(s, i); return isKey ? String(raw.trim()) : scalar(raw, line);
  };
  const v = val(); ws();
  if (i !== t.length) throw new YamlError(`line ${line}: unexpected text after flow collection`);
  return v;
}

/** Parse YAML text into an array of documents. */
export function parseYamlAll(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const docs = []; let cur = [];
  for (const l of lines) { if (/^---(\s|$)/.test(l) || /^\.\.\.(\s|$)/.test(l)) { docs.push(cur); cur = []; const rest = l.replace(/^---\s*/, ''); if (/^---/.test(l) && rest.trim() && !rest.trim().startsWith('#')) cur.push(rest); } else cur.push(l); }
  docs.push(cur);
  let base = 0; const out = [];
  for (const d of docs) { const v = parseDoc(d, base); if (v !== undefined) out.push(v); base += d.length + 1; }
  return out;
}

function parseDoc(raw, base) {
  const over = new Map();
  const info = (i) => { if (over.has(i)) return over.get(i); const r = raw[i]; const indent = r.length - r.trimStart().length; if (/^\s*\t/.test(r)) throw new YamlError(`line ${base + i + 1}: tabs are not allowed for indentation`); return { indent, text: stripComment(r.trim()) }; };
  const sig = (i) => { while (i < raw.length) { if (over.has(i)) return i; const t = raw[i].trim(); if (t && !t.startsWith('#') && !/^%/.test(t)) return i; i++; } return i; };
  const ln = (i) => base + i + 1;

  function blockScalar(head, i, parentIndent) {
    const style = head[0]; const chomp = head.includes('-') ? 'strip' : head.includes('+') ? 'keep' : 'clip';
    const body = []; let j = i; let ind = null;
    for (; j < raw.length; j++) {
      const r = raw[j]; if (!r.trim()) { body.push(''); continue; }
      const n = r.length - r.trimStart().length; if (n <= parentIndent) break;
      if (ind === null) ind = n; body.push(r.slice(Math.min(ind, n)));
    }
    while (body.length && body[body.length - 1] === '' && j > i) { body.pop(); }
    let s = style === '|' ? body.join('\n') : body.reduce((acc, l, k) => acc + (k === 0 ? l : l === '' ? '\n' : (body[k - 1] === '' ? '' : ' ') + l), '');
    if (chomp !== 'strip' && body.length) s += '\n';
    return [s, j];
  }

  function block(i, minIndent) {
    i = sig(i); if (i >= raw.length) return [null, i];
    const { indent, text } = info(i);
    if (indent < minIndent) return [null, i];
    if (text === '-' || text.startsWith('- ')) return seq(i, indent);
    if (KEY_RE.test(text)) return map(i, indent);
    if (text.startsWith('? ')) throw new YamlError(`line ${ln(i)}: complex keys are not supported`);
    return [scalar(text, ln(i)), i + 1];
  }

  function value(rest, i, indent) {
    // rest: text after "key:" or "- " on line i; returns [value, next index]
    if (rest === '') {
      const j = sig(i + 1); if (j >= raw.length) return [null, j];
      const nx = info(j);
      if (nx.indent > indent) return block(j, nx.indent);
      if (nx.indent === indent && (nx.text === '-' || nx.text.startsWith('- '))) return seq(j, indent);
      return [null, j];
    }
    if (/^[|>][-+0-9]*$/.test(rest)) return blockScalar(rest, i + 1, indent);
    return [scalar(rest, ln(i)), i + 1];
  }

  function map(i, indent) {
    const o = {};
    for (;;) {
      i = sig(i); if (i >= raw.length) break;
      const { indent: n, text } = info(i);
      if (n < indent) break;
      if (n > indent) throw new YamlError(`line ${ln(i)}: unexpected indentation`);
      if (text === '-' || text.startsWith('- ')) break;
      const m = KEY_RE.exec(text); if (!m) throw new YamlError(`line ${ln(i)}: expected "key: value"`);
      let k = m[1]; if (k[0] === '"' || k[0] === "'") k = String(scalar(k, ln(i)));
      if (k === '<<') throw new YamlError(`line ${ln(i)}: merge keys are not supported`);
      const [v, nx] = value(text.slice(m[0].length).trim(), i, indent);
      o[k.trim()] = v; i = nx;
    }
    return [o, i];
  }

  function seq(i, indent) {
    const a = [];
    for (;;) {
      i = sig(i); if (i >= raw.length) break;
      const { indent: n, text } = info(i);
      if (n !== indent || !(text === '-' || text.startsWith('- '))) { if (n > indent) throw new YamlError(`line ${ln(i)}: unexpected indentation`); break; }
      const rest = text === '-' ? '' : text.slice(2).trimStart(); const off = text.length - rest.length;
      if (rest && (KEY_RE.test(rest) || rest === '-' || rest.startsWith('- '))) { over.set(i, { indent: indent + off, text: rest }); const [v, nx] = block(i, indent + off); over.delete(i); a.push(v); i = nx; }
      else { const [v, nx] = value(rest, i, indent); a.push(v); i = nx; }
    }
    return [a, i];
  }

  const s = sig(0); if (s >= raw.length) return undefined;
  const [v, end] = block(s, 0); const e = sig(end);
  if (e < raw.length) throw new YamlError(`line ${ln(e)}: unexpected content`);
  return v;
}
