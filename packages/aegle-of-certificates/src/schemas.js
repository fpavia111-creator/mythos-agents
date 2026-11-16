// JSON Schemas for files Aegle reads. Checked with ctx.readJson(path, name) and
// `aegle-of-certificates validate-config <name> <file>`.

const requirementList = {
  type: 'array',
  items: {
    type: 'object', additionalProperties: false, required: ['coverage'],
    properties: {
      coverage: { type: 'string', minLength: 1, description: 'e.g. general_liability, auto_liability, umbrella, workers_comp, professional_liability' },
      min_limit: { type: 'number', minimum: 0 },
      additional_insured: { type: 'boolean' },
      waiver_of_subrogation: { type: 'boolean' },
      note: { type: 'string' },
    },
  },
};

export const COI_REQUIREMENTS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Aegle COI requirement profile',
  type: 'object', additionalProperties: false, required: ['default'],
  properties: {
    version: { type: 'integer', minimum: 1 },
    default: { $ref: '#/$defs/requirementList' },
    categories: { type: 'object', additionalProperties: { $ref: '#/$defs/requirementList' }, description: 'Requirement list per vendor category (trade or risk tier)' },
    vendors: { type: 'object', additionalProperties: { type: 'string', minLength: 1 }, description: 'Vendor name → category. A COI row\'s category column also works.' },
  },
  $defs: { requirementList },
};
