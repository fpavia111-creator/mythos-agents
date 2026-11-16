// Zero-dependency JSON Schema subset validator (draft 2020-12 keywords that
// tool inputs and agent configs actually use). Errors carry a JSON pointer.
//
// Supported: type (string or array), enum, const, required, properties,
// additionalProperties (false or a schema), items, minItems, maxItems,
// uniqueItems, minimum, maximum, exclusiveMinimum, exclusiveMaximum,
// minLength, maxLength, pattern, format (date, date-time, email, uri),
// oneOf, anyOf, allOf, not, $ref to #/$defs/* or #/definitions/*.
// Unknown keywords are ignored (annotation-only), as JSON Schema says.

const FORMATS = {
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')),
  'date-time': (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s)),
  email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
  uri: (s) => /^[a-z][a-z0-9+.-]*:/i.test(s),
};

const esc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(t, v) {
  const actual = typeOf(v);
  if (t === actual) return true;
  if (t === 'number' && actual === 'integer') return true;
  return false;
}

function resolveRef(root, ref) {
  const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref || '');
  if (!m) throw new Error(`unsupported $ref "${ref}" (use #/$defs/name)`);
  const s = root[m[1]] && root[m[1]][m[2].replace(/~1/g, '/').replace(/~0/g, '~')];
  if (!s) throw new Error(`$ref "${ref}" not found`);
  return s;
}

function check(schema, v, ptr, root, errs, depth) {
  if (depth > 64) { errs.push({ path: ptr || '/', message: 'schema nesting too deep' }); return; }
  if (schema === true || schema === undefined || schema === null) return;
  if (schema === false) { errs.push({ path: ptr || '/', message: 'no value is allowed here' }); return; }
  if (schema.$ref) { check(resolveRef(root, schema.$ref), v, ptr, root, errs, depth + 1); return; }
  const at = ptr || '/';
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, v))) {
      errs.push({ path: at, message: `expected ${types.join(' or ')}, got ${typeOf(v)}` });
      return;
    }
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(v)) errs.push({ path: at, message: `must equal ${JSON.stringify(schema.const)}` });
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) {
    errs.push({ path: at, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}` });
  }
  if (typeof v === 'string') {
    if (schema.minLength !== undefined && [...v].length < schema.minLength) errs.push({ path: at, message: `must be at least ${schema.minLength} characters` });
    if (schema.maxLength !== undefined && [...v].length > schema.maxLength) errs.push({ path: at, message: `must be at most ${schema.maxLength} characters` });
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(v)) errs.push({ path: at, message: `must match ${schema.pattern}` });
    if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format](v)) errs.push({ path: at, message: `must be a valid ${schema.format}` });
  }
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) errs.push({ path: at, message: `must be >= ${schema.minimum}` });
    if (schema.maximum !== undefined && v > schema.maximum) errs.push({ path: at, message: `must be <= ${schema.maximum}` });
    if (schema.exclusiveMinimum !== undefined && v <= schema.exclusiveMinimum) errs.push({ path: at, message: `must be > ${schema.exclusiveMinimum}` });
    if (schema.exclusiveMaximum !== undefined && v >= schema.exclusiveMaximum) errs.push({ path: at, message: `must be < ${schema.exclusiveMaximum}` });
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) errs.push({ path: at, message: `must have at least ${schema.minItems} items` });
    if (schema.maxItems !== undefined && v.length > schema.maxItems) errs.push({ path: at, message: `must have at most ${schema.maxItems} items` });
    if (schema.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errs.push({ path: at, message: 'items must be unique' });
    if (schema.items && typeof schema.items === 'object') v.forEach((x, i) => check(schema.items, x, `${ptr}/${i}`, root, errs, depth + 1));
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of schema.required || []) if (!(k in v) || v[k] === undefined) errs.push({ path: `${ptr}/${esc(k)}`, message: 'is required' });
    const props = schema.properties || {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue;
      if (Object.prototype.hasOwnProperty.call(props, k)) check(props[k], x, `${ptr}/${esc(k)}`, root, errs, depth + 1);
      else if (schema.additionalProperties === false) errs.push({ path: `${ptr}/${esc(k)}`, message: 'is not an allowed property' });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') check(schema.additionalProperties, x, `${ptr}/${esc(k)}`, root, errs, depth + 1);
    }
  }
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) check(s, v, ptr, root, errs, depth + 1);
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((s) => { const e = []; check(s, v, ptr, root, e, depth + 1); return !e.length; })) errs.push({ path: at, message: 'does not match any allowed shape (anyOf)' });
  }
  if (Array.isArray(schema.oneOf)) {
    const n = schema.oneOf.filter((s) => { const e = []; check(s, v, ptr, root, e, depth + 1); return !e.length; }).length;
    if (n !== 1) errs.push({ path: at, message: `must match exactly one allowed shape (oneOf), matched ${n}` });
  }
  if (schema.not) { const e = []; check(schema.not, v, ptr, root, e, depth + 1); if (!e.length) errs.push({ path: at, message: 'matches a shape that is not allowed (not)' }); }
}

/** Validate a value. Returns { ok, errors: [{ path, message }] } with JSON-pointer paths. */
export function validate(schema, value) {
  const errors = [];
  check(schema, value, '', schema || {}, errors, 0);
  return { ok: errors.length === 0, errors };
}

export class ValidationError extends Error {
  constructor(label, errors) {
    super(`${label}: ${errors.slice(0, 8).map((e) => `${e.path} ${e.message}`).join('; ')}${errors.length > 8 ? ` (+${errors.length - 8} more)` : ''}`);
    this.errors = errors;
  }
}

/** Throw a ValidationError (with JSON pointers) unless value matches schema. */
export function assertValid(schema, value, label = 'invalid value') {
  const r = validate(schema, value);
  if (!r.ok) throw new ValidationError(label, r.errors);
  return value;
}
