# Changelog

## 0.2.0 (2026-11-15)

- Versioned vendor list in `src/vendors.json` (`britomartis-vendor-list` v2026.11.0: about 135 hosts and 90 cookie patterns, up from 31 and 26). Every purpose guess carries `vendor_list` with the list name and version, and finding text cites it. Purposes stay labelled `known_list (guess)`.
- Optional `vendors` argument: your own vendor list, matched before the built-in one and cited by its own version.
- Global Privacy Control check: captures whose requests carry `Sec-GPC: 1` (new `har_gpc` argument, or any capture) are checked for analytics and marketing items (`gpc_signal_ignored`). `.well-known/gpc.json` in the site folder is read; claiming GPC support makes a hit an error, and an untested claim is an advisory (`gpc_not_tested`). The result has a `gpc` summary.
- New `britomartis_diff_inventory` (read): compares an earlier `inventory.json` with the current captures.
- `britomartis_write_report` also writes `consent-audit.html` (self-contained, no scripts) and `inventory.json` (no cookie values), and records an `output_sha256` in the audit line.
- Config schemas `declared_policy` and `vendor_list` (`validate-config`), loaded through `ctx.readJson`, so typos fail with JSON-pointer errors.
- MCP prompt `britomartis_consent_audit`; MCP tool titles.
- Optional `britomartis-capture` command: records first-visit, after-reject, after-accept and GPC HAR files with a headless browser, cookie values redacted. Needs Playwright, which you install yourself (not a dependency; imported only when the command runs). Makes network requests unless `--offline`. No MCP tool runs it.
- Fixtures: `har/gpc-visit.har`, `inventory-previous.json`, and `capture-site/` (a local copy of the bakery that reproduces the bundled HARs when captured offline).

Hardening (review pass)

- The cookie table hash in `proposal.json` is the hash of the file as written.
- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

## 0.1.0

- First release: inventory, report, cookie-table draft, one-click publish request.
