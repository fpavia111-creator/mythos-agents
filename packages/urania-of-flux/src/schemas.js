// JSON Schemas for the files Urania reads back. Loaded with ctx.readJson(path, name),
// so a hand-edited or truncated pack-manifest.json fails with a JSON-pointer error.
const sha = { type: 'string', pattern: '^[0-9a-f]{64}$' };

export const PACK_MANIFEST_SCHEMA = Object.freeze({
  $id: 'urania-of-flux/pack_manifest',
  type: 'object',
  additionalProperties: false,
  required: ['title', 'pack', 'pack_sha256', 'figures', 'figures_sha256', 'docs', 'claims_checked', 'claims_issues'],
  properties: {
    title: { type: 'string', minLength: 1 },
    period: { type: 'string' },
    pack: { type: 'string', minLength: 1 },
    pack_sha256: sha,
    figures: { type: 'string', minLength: 1 },
    figures_sha256: sha,
    docs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'sha256'], properties: { path: { type: 'string' }, sha256: sha } } },
    claims_checked: { type: 'integer', minimum: 0 },
    claims_issues: { type: 'integer', minimum: 0 },
    open_markers: { type: 'integer', minimum: 0 },
    html: { type: 'string' },
    html_sha256: sha,
  },
});
