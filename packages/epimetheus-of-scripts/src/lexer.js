// A small JavaScript tokenizer (no dependencies). It separates code from comments,
// strings, template text and regex literals, so pattern checks only see real code.
// It is not a full parser: it is enough to find identifiers, define()/require()
// dependency lists and their aliases, with line numbers.

const PUNCT_BEFORE_REGEX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '=>', '&&', '||', '??', '==', '===', '!=', '!==', '+=', '-=', '*=', '/=', '<=', '>=', '...']);
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'instanceof', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'of']);
const MULTI = ['===', '!==', '...', '=>', '&&', '||', '??', '==', '!=', '+=', '-=', '*=', '/=', '<=', '>=', '++', '--', '?.'];

const isIdStart = (c) => /[A-Za-z_$À-￿]/.test(c);
const isId = (c) => /[A-Za-z0-9_$À-￿]/.test(c);

/**
 * Tokenize JavaScript source.
 * Returns { tokens: [{ type: 'ident'|'string'|'template'|'num'|'punct'|'regex', value, line }], comments: [{ text, line }] }.
 * String values are unquoted (escapes kept as written). Unterminated literals end at end of input.
 */
export function tokenize(src) {
  const tokens = []; const comments = [];
  let i = 0; let line = 1; const n = src.length;
  const prevSignificant = () => tokens[tokens.length - 1] || null;
  const regexAllowed = () => {
    const p = prevSignificant();
    if (!p) return true;
    if (p.type === 'punct') return PUNCT_BEFORE_REGEX.has(p.value);
    if (p.type === 'ident') return KEYWORDS_BEFORE_REGEX.has(p.value);
    return false;
  };
  const count = (s) => { for (const ch of s) if (ch === '\n') line++; };

  function readString(q) {
    const start = line; let j = i + 1; let out = '';
    while (j < n && src[j] !== q) {
      if (src[j] === '\\') { out += src[j] + (src[j + 1] || ''); if (src[j + 1] === '\n') line++; j += 2; continue; }
      if (src[j] === '\n') break; // unterminated
      out += src[j]; j++;
    }
    tokens.push({ type: 'string', value: out, line: start });
    i = Math.min(n, j + 1);
  }

  // Template literal: text parts become one 'template' token; ${...} parts are tokenized as code.
  function readTemplate() {
    const start = line; let j = i + 1; let text = '';
    while (j < n) {
      const c = src[j];
      if (c === '\\') { text += c + (src[j + 1] || ''); if (src[j + 1] === '\n') line++; j += 2; continue; }
      if (c === '`') { j++; break; }
      if (c === '$' && src[j + 1] === '{') {
        i = j + 2; lexUntilBrace(); j = i; continue;
      }
      if (c === '\n') line++;
      text += c; j++;
    }
    tokens.push({ type: 'template', value: text, line: start });
    i = j;
  }

  function lexUntilBrace() {
    let depth = 0;
    while (i < n) {
      if (src[i] === '}' && depth === 0) { i++; return; }
      if (src[i] === '{') depth++;
      if (src[i] === '}') depth--;
      step();
    }
  }

  function step() {
    const c = src[i];
    if (c === '\n') { line++; i++; return; }
    if (/\s/.test(c)) { i++; return; }
    if (c === '/' && src[i + 1] === '/') {
      let j = i; while (j < n && src[j] !== '\n') j++;
      comments.push({ text: src.slice(i, j), line }); i = j; return;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2); if (j < 0) j = n - 2;
      const text = src.slice(i, j + 2); comments.push({ text, line }); count(text); i = j + 2; return;
    }
    if (c === '"' || c === "'") { readString(c); return; }
    if (c === '`') { readTemplate(); return; }
    if (c === '/' && regexAllowed()) {
      let j = i + 1; let inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true; else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j++;
      }
      j++; while (j < n && /[a-z]/i.test(src[j])) j++;
      tokens.push({ type: 'regex', value: src.slice(i, j), line }); i = j; return;
    }
    if (isIdStart(c)) {
      let j = i + 1; while (j < n && isId(src[j])) j++;
      tokens.push({ type: 'ident', value: src.slice(i, j), line }); i = j; return;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i + 1; while (j < n && /[0-9a-zA-Z_.]/.test(src[j])) j++;
      tokens.push({ type: 'num', value: src.slice(i, j), line }); i = j; return;
    }
    const m = MULTI.find((p) => src.startsWith(p, i));
    const v = m || c;
    tokens.push({ type: 'punct', value: v, line }); i += v.length;
  }

  while (i < n) step();
  return { tokens, comments };
}

/** Lines (1-based) that hold at least one code token. */
export function codeLines(tokens) {
  return new Set(tokens.map((t) => t.line));
}

/**
 * Find AMD dependency lists: define([...], function (a, b) {}) / define([...], (a, b) => {})
 * and require([...], cb), plus var x = require('N/x').
 * Returns [{ fn: 'define'|'require', module, alias|null, line }].
 */
export function findDependencies(tokens) {
  const deps = [];
  const isP = (t, v) => t && t.type === 'punct' && t.value === v;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== 'ident' || (t.value !== 'define' && t.value !== 'require')) continue;
    const before = tokens[k - 1];
    if (isP(before, '.')) continue; // obj.define(...)
    if (!isP(tokens[k + 1], '(')) continue;
    // Form 1: define([ 'a', 'b' ], callback)
    if (isP(tokens[k + 2], '[')) {
      const mods = []; let j = k + 3;
      while (j < tokens.length && !isP(tokens[j], ']')) {
        if (tokens[j].type === 'string') mods.push({ module: tokens[j].value, line: tokens[j].line });
        j++;
      }
      // callback parameters
      let params = [];
      if (isP(tokens[j + 1], ',')) {
        let p = j + 2;
        if (tokens[p] && tokens[p].type === 'ident' && tokens[p].value === 'function') { p++; if (tokens[p] && tokens[p].type === 'ident') p++; }
        if (tokens[p] && tokens[p].type === 'ident' && tokens[p].value === 'async') p++;
        if (isP(tokens[p], '(')) {
          p++;
          while (p < tokens.length && !isP(tokens[p], ')')) { if (tokens[p].type === 'ident' && (isP(tokens[p + 1], ',') || isP(tokens[p + 1], ')') || isP(tokens[p + 1], '='))) params.push(tokens[p].value); p++; }
        } else if (tokens[p] && tokens[p].type === 'ident' && isP(tokens[p + 1], '=>')) params = [tokens[p].value];
      }
      mods.forEach((m, idx) => deps.push({ fn: t.value, module: m.module, alias: params[idx] || null, line: m.line }));
      continue;
    }
    // Form 2: var x = require('N/x')
    if (t.value === 'require' && tokens[k + 2] && tokens[k + 2].type === 'string' && isP(tokens[k + 3], ')')) {
      const alias = isP(before, '=') && tokens[k - 2] && tokens[k - 2].type === 'ident' ? tokens[k - 2].value : null;
      deps.push({ fn: 'require', module: tokens[k + 2].value, alias, line: tokens[k + 2].line });
    }
  }
  return deps;
}
