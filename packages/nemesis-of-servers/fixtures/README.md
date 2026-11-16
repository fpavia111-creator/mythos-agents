Fictional fixtures for demos, tests and evals. Fake values only (AKIAIOSFODNN7EXAMPLE is AWS's documented example key); every package, host and person name is made up or on a reserved domain.

- `risky-server/`: deliberately risky sample server (non-runnable `.sample` files).
- `tidy-server/`: a small read-only server with a root check; should produce no findings.
- `flow-server/`: deliberately vulnerable sample (`.sample` files) for data-flow, lockfile, `requirements.txt` and advisory checks.
- `mcp.json`, `mcp-extra.json`: MCP client configs (`mcp-extra.json` has auto-approved tools, a permission-bypass flag, a duplicate server and an advisory-listed fictional package).
- `tools/notes-v1.json`, `tools/notes-v2.json`: a saved `tools/list` before and after a fictional rug pull; `tools/notes-pins.json` pins v1.
- `tools/multi.json`: three fictional servers' tools with shadowing, hidden Unicode, a look-alike name, a free-form SQL parameter and a misleading annotation.
- `nemesis-policy.json`: a reviewer policy (suppression with reason, egress allowlist, severity override).
- `advisories.json`: a fictional advisory list.
