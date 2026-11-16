Fictional projects ("kettle-app" by "Kettle Labs") and a fictional written license policy. The package names, versions, authors and integrity values are made up; nothing is installed and nothing here is a real package. The license problems are planted on purpose so the demo, tests and evals have something to find.

- `project/`: npm project with a hand-written `package-lock.json` (licenses in the lockfile).
- `project-pnpm/`, `project-yarn/`: the same dependency set as `pnpm-lock.yaml` (v9) and `yarn.lock` (classic). Their installed packages are in `installed-npm/` (pass `modules_dir: "../installed-npm"`; the folder is not called `node_modules` because npm never publishes folders of that name). Planted: `hashy` declares no license but ships a BSD-3-Clause text; `@fict/logger` declares MIT but ships an ISC text.
- `project-python/`: `poetry.lock`, `pyproject.toml` and `site-packages/*.dist-info/METADATA` (license expressions, the old `License` field, trove classifiers, and one package with only a license file).
- `project-go/`: `go.mod` and `vendor/` with license files, checked against `license-policy-go.json` (the same policy with exceptions keyed by module path). Go has no dev dependencies and cannot express "MIT OR GPL", so `dual-lib` is plain MIT here and there is no `test-runner-gpl`. The GPL, LGPL, AGPL, MPL and CC-BY files contain only the license heading (so they are title-only, low-confidence matches); `req-cli/LICENSE` is the full Apache License 2.0 text.
- `license-texts/`: texts for the matcher's tests: standard MIT, ISC and BSD texts, an MIT text with an added restriction, a heading-only GPL file and a custom licence.
- `baseline/sbom.cdx.json`: the SBOM of the previous release (kettle-app 1.3.0) for `lycurgus_diff_sbom`.
- `license-policy.json`, `license-policy-go.json`: the fictional policy.

All five projects give the same counts under the policy: 8 allow, 3 review, 2 unknown, 2 deny.
