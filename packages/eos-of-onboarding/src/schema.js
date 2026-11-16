// JSON Schema for the checklist template. additionalProperties:false so a typo
// ("requries", "due_offest_days") fails with a JSON pointer instead of being ignored.
const id = { type: 'string', pattern: '^[A-Za-z0-9_.-]+$' };
export const TEMPLATE_SCHEMA = {
  $defs: {
    task: {
      type: 'object', additionalProperties: false, required: ['id', 'title'],
      properties: {
        id, title: { type: 'string', minLength: 1 },
        kind: { enum: ['document', 'equipment', 'access', 'training', 'meeting', 'task'] },
        owner: { type: 'string' }, system: { type: 'string' }, access_level: { type: 'string' },
        requires: { type: 'array', items: id, uniqueItems: true },
        due_offset_days: { type: 'integer', minimum: -365, maximum: 365 },
        note: { type: 'string' },
      },
    },
    tasks: { type: 'array', items: { $ref: '#/$defs/task' } },
  },
  type: 'object', additionalProperties: false, required: ['types'],
  properties: {
    name: { type: 'string' },
    types: { type: 'object', additionalProperties: { $ref: '#/$defs/tasks' } },
    roles: {
      type: 'object',
      additionalProperties: {
        type: 'object', additionalProperties: false,
        properties: { type: { type: 'string' }, add: { $ref: '#/$defs/tasks' }, remove: { type: 'array', items: id, uniqueItems: true }, note: { type: 'string' } },
      },
    },
    offboarding: { type: 'object', additionalProperties: { $ref: '#/$defs/tasks' } },
    offboarding_access_offset_days: { type: 'integer', minimum: -30, maximum: 30 },
  },
};
