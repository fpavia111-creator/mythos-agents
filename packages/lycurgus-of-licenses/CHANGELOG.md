# Changelog

## 0.2.0 (2026-11-15)

- **More lockfiles:** `pnpm-lock.yaml` (v6–v9), `yarn.lock` (classic and Berry), Python (`poetry.lock`, `uv.lock`, `requirements.txt` with `*.dist-info/METADATA`) and Go (`go.mod`, `vendor/modules.txt` with license files under `vendor/`). New arguments `ecosystem`, `modules_dir`, `site_packages`; the lockfile is detected by default. SBOM purls and SARIF locations follow the ecosystem. The release request re-hashes whichever lockfile was checked.
- **License text detection:** when metadata declares no license (or `SEE LICENSE IN` a file), the package's license file is compared with standard texts. MIT, ISC, 0BSD, BSD-2-Clause, BSD-3-Clause and the Unlicense are compared word by word; Apache-2.0 and MPL-2.0 against a fingerprint of the official text; the GPL family and CC-BY-4.0 by title only. A close match is used (`license_from_text`); a low-confidence match is never allowed and goes to review or stricter (`license_text_low_confidence`). A declared license that disagrees with a closely matched license file is flagged (`license_text_mismatch`). `detect_text: false` turns it off.
- New `lycurgus_write_notices` (report): `THIRD-PARTY-NOTICES.md` draft and `attribution.csv` from installed license files, with `[TO ADD]` markers where no text was found. Policy field `attribution.not_required`.
- New `lycurgus_diff_sbom` (read): what changed since an earlier CycloneDX SBOM, and which new or relicensed dependencies the policy does not allow.
- New advisory findings `exception_unused` and `exception_expiring` (within 30 days). `lycurgus_write_report` also writes `exceptions.ics` and records an `output_sha256` in the audit line; `licenses.csv` gains `license_source` and `text_match` columns.
- Config schema `license_policy` (`validate-config`), loaded through `ctx.readJson`.
- MCP prompt `lycurgus_license_review`; MCP tool titles; `as_of` must be `YYYY-MM-DD`.
- CLI `check` accepts `--ecosystem`, `--modules-dir`, `--site-packages`.

### Changed behaviour

- A policy file that is not a valid policy now fails with schema errors and JSON pointers (`/source is required`) instead of `policy.source is required`. Unknown keys in the policy are now errors; before they were ignored.
- A package with no declared license that ships a standard license file may now be `allow` or `review` instead of `unknown`. Use `detect_text: false` for the 0.1.0 behaviour.

### Hardening (review pass)

- Inherited from `mythos-agent-core`: CSV cells that a spreadsheet would run as a formula are neutralised; Markdown output has raw HTML and remote images from data turned into literal text; HTML report tables scroll on narrow screens and header cells carry `scope`; results that quote instruction-like text from data carry a warning; near-miss argument names are refused with the right name; file errors are plain and relative to `--root`.

## 0.1.0

- First release: npm lockfile check, report, CycloneDX SBOM, SARIF, exception stubs, one-click release request.
