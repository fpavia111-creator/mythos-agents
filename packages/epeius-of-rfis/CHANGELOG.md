# Changelog

## 0.2.0 (2026-11-15)

Fixed (handoff ver 6)
- RFIs written in Japanese, Chinese or Korean had no words to compare, so duplicates were never flagged; such text is compared by character pairs.

- Real exports: Reads Procore RFI exports directly (layout checked against Procore's documentation on 2026-11-15); submittal and document logs map common column names. Table inputs also accept TSV and Excel `.xlsx`; `inspect <file>` and `mythos-sources.json` help when columns differ.
- New `epeius_ball_in_court` (read): open RFIs and submittals per responsible party in 0-7, 8-14, 15-30 and 31+ day buckets, overdue counts, oldest item, and a chase list ordered by days overdue with a reason per item. The submittal log can carry an optional `ball_in_court` column.
- New `epeius_diff_logs` (read): compares an earlier RFI log export with the current one (new, closed, reopened, status, due-date and ball-in-court changes, newly overdue, removed).
- New `epeius_index_title_blocks` (report): reads sheet number, title, revision table and issue date from title-block text files, compares them with the index and writes a proposed index. Your index is not changed.
- New `epeius_draft_transmittal` (write, ask, Auto-eligible): drafts `drafts/TR-<no>.md` listing only indexed documents on their current revisions with extract hashes; unknown references and old revisions are marked. Sending goes through `epeius_request_send`, which stays one-click and now accepts transmittals too.
- `epeius_write_log_report` also writes `ball-in-court.csv`, `rfi-due-dates.ics` and (with `previous_rfis`) `rfi-log-diff.md`, and records an `output_sha256` in the audit line. `submittal-log.csv` gains a `ball_in_court` column.
- MCP prompt `epeius_weekly_rfi_review`.
- Tool titles for MCP hosts; stricter input schemas (dates, purpose enum, transmittal number pattern).
- Fixtures: `submittals.csv` gains a `ball_in_court` column; new `rfis-previous.csv` and `titleblocks/`.
- No config file is read, so no config schemas are declared.

Hardening (review pass)

- RFI and transmittal draft file names are built with `safeFileName`; `draft_sha256` is the hash of the file as written.
- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

Speed (ver 4)

- Possible duplicate RFIs: word sets are built once, and only RFIs sharing one of the rarest words of each are compared (an exact filter; same flags as before, checked on 300 random logs). 10,000 RFIs no longer time out.
- An RFI similar to many earlier RFIs names the first five and adds "Similar to N more earlier RFI(s)." instead of one note per match.

## 0.1.0

- First release: log review, log report, RFI drafts with citations, one-click send request.
