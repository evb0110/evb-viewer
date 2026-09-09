# Project 6 consolidation reports

`scripts/project6ConsolidationReport.mjs` produces a deterministic report for
an exact pair of Git commits. It reads both trees from Git, so a dirty checkout
or an unrelated `HEAD` cannot change the measured input.

```sh
node scripts/project6ConsolidationReport.mjs \
  --base=<full-commit-id> \
  --head=<full-commit-id> \
  --format=markdown \
  --output=.devkit/analysis/project6/consolidation-report.md
```

Use `--format=json` for machine-readable output. The report includes the
resolved base and head identities, production and test line counts by the
explicit domain manifest, file/byte deltas, rename-aware changed paths, and
the informational commit-title trend. Rust files use the existing inline-test
splitter. Non-counted text and binary files are reported with byte size and Git
blob identity, never as source lines.

The domain manifest names the Project 6 ticket owners and marks shared paths as
`shared-owner`. Paths outside the manifest appear under `unassigned` and are
listed rather than assigned by directory guesswork. The report also emits every
manifest prefix with its raw match count and effective owned-path count,
including zero-match and fully shadowed prefixes. A stale or shadowed prefix
cannot silently produce an empty domain. Overlapping prefixes use the longest
matching prefix. A moved file records both its old and new domain, so a
cross-domain move is visible and cannot be counted as an unexplained deletion
and addition.

Only the extensions listed in the script's `CODE_EXTENSIONS` set contribute to
line totals. Text inputs such as Markdown, JSON, YAML, CSS, and SCSS appear in
the non-counted text section with their byte size and Git blob identity. The
binary section is reserved for files outside both sets, such as archives and
WASM payloads. All report sorting uses code-unit ordering so JSON and Markdown
hashes remain reproducible across hosts.

The `fix`-title count and all line deltas are reporting signals. This command
does not block a build, enforce a reduction quota, change #296's fixed
scan-cleanup ceiling, or replace coverage, platform, release, or behavioral
evidence. Generate a report at the same exact candidate used by those gates
and retain its JSON/Markdown hashes with the ticket evidence.
