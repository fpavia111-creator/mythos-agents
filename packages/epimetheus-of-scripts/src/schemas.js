// JSON Schema for the optional effort-calibration file. Loaded with
// ctx.readJson(path, 'estimate_config') so typos fail with JSON-pointer errors.

const hours = { type: 'number', minimum: 0 };

export const estimateConfigSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Epimetheus effort weights (hours)',
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, description: 'Label shown next to every estimate, e.g. "Team A calibration, Q3"' },
    base_hours: {
      type: 'object', additionalProperties: false,
      properties: { '1.0': hours, '2.0': hours, '2.x': hours, '2.1': hours, unknown: hours },
    },
    per_distinct_api: hours,
    per_call: hours,
    per_100_loc: hours,
    redesign: hours,
    writes: hours,
    external: hours,
    unmapped_api: hours,
    mixed_versions: hours,
    per_custom_dependency: hours,
  },
};
