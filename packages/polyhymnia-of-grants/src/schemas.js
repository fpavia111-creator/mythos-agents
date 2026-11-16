// JSON Schemas for files Polyhymnia reads. Checked with ctx.readJson(path, name)
// and `polyhymnia-of-grants validate-config <name> <file>`.
import { SECTION_SOURCES } from './extras.js';

export const FUNDER_TEMPLATE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Polyhymnia funder report template',
  type: 'object', additionalProperties: false, required: ['name', 'sections'],
  properties: {
    name: { type: 'string', minLength: 1 },
    title: { type: 'string', description: 'Report heading, e.g. "Interim report"' },
    applies_to_funders: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Funder names this template is for (warns on others)' },
    sections: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'title', 'source'],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9_-]+$' },
          title: { type: 'string', minLength: 1 },
          source: { enum: SECTION_SOURCES, description: 'Where the content comes from; narrative and custom are written by a person' },
          required: { type: 'boolean' },
          max_words: { type: 'integer', minimum: 1 },
          guidance: { type: 'string', description: "The funder's own instructions for the section, copied by you" },
        },
      },
    },
    required_attachments: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'file'], properties: { id: { type: 'string', pattern: '^[a-z0-9_-]+$' }, title: { type: 'string', minLength: 1 }, file: { type: 'string', minLength: 1, description: 'Path relative to the outcomes file, like evidence paths' } } },
    },
    variance_threshold_pct: { type: 'number', minimum: 0, maximum: 10, description: 'Funder rule: explain lines whose variance exceeds this share (0.1 = 10%)' },
    variance_threshold_amount: { type: 'number', minimum: 0 },
  },
};
