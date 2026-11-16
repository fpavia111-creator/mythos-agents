# Changelog

## 0.2.0 — 2026-11-15

### Added
- Configurable send windows: `days`, `start_hour`, `end_hour`, `time_zone`, several `windows`, and `blackout_dates`. A draft's `time_zone` column checks the window in the recipient's zone. DST is handled by the time-zone database (tests cover Chicago and London, both directions). `nextWindow` searches up to 60 days.
- Spam-phrase check: built-in list plus `spam_words`; each hit is cited with field, position and snippet. Warnings by default, or holds with `spam_policy: "hold"`.
- Link checks: URL shorteners and raw IP links hold; with `link_allowlist`, links (including the unsubscribe link) outside the allowed domains hold; plain http and more than `max_links` links warn.
- Unfilled placeholder check (`{{first_name}}`, `{Company}`, `*|FNAME|*`, `%FNAME%`, `[First Name]`) holds the draft.
- `eucleia_import_suppression`: imports opt-outs and bounces from Mailchimp, HubSpot and Resend exports (format detected from the header); adds only. Ask, Auto-eligible.
- `eucleia_plan_schedule`: plans send slots inside each recipient's window with a daily cap and minimum gap; writes `schedule.csv` and `schedule.ics` (one all-day entry per sending day, no addresses). Its hash is logged as `output_sha256`.
- `eucleia_release_batch` logs the hash of `release.json` as `output_sha256`.
- `eucleia-config` config schema (`configSchemas`), loaded with JSON-pointer errors, plus checks for unknown time zones and inverted hours; `validate-config eucleia-config <file>`.
- MCP prompt `eucleia_outreach_batch`; `title` on the new tools.
- Fixtures: ESP exports (Mailchimp, HubSpot, Resend) for the same three fictional people; `drafts-checks.csv`; `eucleia.json` gained `link_allowlist`, `blackout_dates`, `max_per_day` and `min_gap_minutes` (existing results unchanged).

### Unchanged
- Releasing a batch is `binding_send`: one named human click, even in Auto. Sending stays blocked. All existing tests and evals pass unchanged.

### Hardening (review pass)

- `eucleia_plan_schedule` refuses `min_gap_minutes` over 1440, `max_per_day` over 100000 and `horizon_days` over 366, and no longer steps minute by minute through a gap. Before this a very large gap never returned. Plans for valid inputs are unchanged (96 configurations compared).
- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

Speed (ver 4)

- Date formatters are built once per time zone, spam-phrase patterns once per phrase, and the next-window search once per send time. Checking 10,000 drafts went from over 3 minutes to under 1 s; output is byte-for-byte the same.
- Scheduling finds the gap with a binary search and does not repeat a search that already found no slot. Same plans as before (checked on 60 random batches).
