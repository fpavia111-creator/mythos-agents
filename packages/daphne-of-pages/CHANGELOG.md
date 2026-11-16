# Changelog

## 0.2.0 — 2026-11-15

### Added
- Contrast from static CSS (`contrast_low`, maps to WCAG 1.4.3): `<style>` blocks, local stylesheets and inline styles, with cascade and inheritance; 4.5:1, or 3:1 for large text. Elements whose colours cannot be read statically are skipped and counted in `contrast.elements_skipped`.
- Focus checks: `focus_outline_removed` (2.4.7) and `focusable_in_aria_hidden` (4.1.2).
- ARIA misuse: `aria_role_invalid`, `aria_attr_invalid`, `aria_value_invalid`, `aria_reference_missing`, `aria_role_not_focusable`, `aria_presentation_focusable`, `aria_img_name_missing`, `aria_hidden_body`.
- sitemap.xml and robots.txt consistency (`sitemap_missing_page`, `sitemap_dead_url`, `sitemap_url_blocked`, `sitemap_lists_noindex`, `sitemap_lists_non_canonical`, `robots_blocks_page`, `robots_blocks_all`, `robots_no_sitemap` and others), run only when one of the files is in the site folder. Nothing is fetched.
- A CSS `selector` on every element-level issue, and a `selector` column in `fix-list.csv`.
- `top_actions`: a prioritised "do these first" list that groups issues by check and selector and marks likely template fixes. It leads the Markdown and the new self-contained `page-audit.html` report.
- `fixes.diff` from `daphne_draft_fixes`: every mechanical fix as one unified diff; its hash is in `proposal.json` and is checked before a publish is recorded.
- `audit_config` config schema and `config` argument; `daphne-of-pages validate-config audit_config <file>`.
- MCP prompt `daphne_site_review`.
- `output_sha256` on report, draft and publish results (recorded in the audit line).
- Fixtures: `shop/` (a second fictional site with a stylesheet, sitemap.xml and robots.txt) and `daphne.config.json`.

### Changed
- `fix-list.csv` has a new `selector` column after `line`.
- The limits note now says contrast is computed from static CSS only (before 0.2.0 it said contrast was not checked).
- Results on the original `site/` fixture are unchanged (25 issues).

### Hardening (review pass)

- Markdown report hashes are taken from the text as written; fix hints such as `<button>` now show as text in a Markdown preview.
- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

