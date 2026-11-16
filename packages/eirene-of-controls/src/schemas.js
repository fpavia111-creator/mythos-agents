// JSON Schema for the user's control list. Loaded with ctx.readJson(path, 'controls')
// so typos fail with JSON-pointer errors instead of silently matching nothing.

const MATCH_FIELDS = ['agent', 'tool', 'kind', 'category', 'mode', 'decision', 'status', 'approved_by', 'reason', 'file', 'detail'];
const match = {
  type: 'object', additionalProperties: false,
  description: 'Event fields to match. Values are exact text, "*" (anything), or a glob with * and ?, e.g. "augeas_*" or "?*" (not blank).',
  properties: Object.fromEntries(MATCH_FIELDS.map((k) => [k, { type: 'string' }])),
};

export const controlSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title'],
  properties: {
    id: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    owner: { type: 'string' },
    frequency: { enum: ['daily', 'weekly', 'monthly', 'quarterly', 'semiannual', 'annual'] },
    match,
    match_any: { type: 'array', items: match, minItems: 1 },
    evidence_files: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: 'Globs relative to evidence_dir; a pattern without "/" matches the file name' },
    notes: { type: 'string' },
  },
};

// One schema for both shapes (a bare array, or { name, description, controls }) so errors keep
// precise JSON pointers: "items" applies only to arrays, the object keywords only to objects.
export const controlsSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Eirene control list (your own control ids)',
  type: ['array', 'object'],
  items: { $ref: '#/$defs/control' },
  additionalProperties: false,
  required: ['controls'],
  properties: { name: { type: 'string' }, description: { type: 'string' }, controls: { type: 'array', items: { $ref: '#/$defs/control' } } },
  $defs: { control: controlSchema },
};
