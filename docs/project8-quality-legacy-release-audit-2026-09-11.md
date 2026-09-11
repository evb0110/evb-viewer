# Project 8 quality and legacy release audit

Review date: 2026-09-11

Source under review: `876be7914` (`origin/project8/integration`)

Tickets: [#521](https://github.com/evb0110/evb-viewer/issues/521),
[#522](https://github.com/evb0110/evb-viewer/issues/522), and
[#551](https://github.com/evb0110/evb-viewer/issues/551)

## #521, installed Windows ARM64 readiness

The original bypass is repaired in the reviewed source. The reusable Windows
target workflow now installs the produced NSIS artifact, waits for required
runtime files, launches the installed executable through the packaged core PDF
smoke, runs the uninstaller, and fails if the executable remains. The ARM64
artifact job depends on the quality job and uses that same reusable target. The
release artifact summary reports the ARM64 job result instead of treating an
uploaded file as proof.

Relevant source:

- `.github/workflows/build-target.yml`, the NSIS install, packaged smoke, and
  uninstall block.
- `.github/workflows/release-artifacts.yml`, `build_win_arm64` and its required
  result in the artifact summary.
- `.github/workflows/release-supplemental.yml`, the ARM64 build and attach
  dependency chain.

This is a source qualification only. No Windows ARM64 hosted runner was
available in this VPS lane, so an exact installer digest, tested commit, and
successful installed-app run remain external acceptance gaps. The branch does
not claim those results.

## #522, mirror and GitHub promotion ordering

The publisher has useful local safeguards. It uploads and verifies immutable
release objects before changing the mutable channel, uses conditional channel
writes, keeps drill prefixes isolated, and restores the previous channel after
a publisher-owned channel mutation fails. The release status command reports
GitHub release visibility, assets, workflow results, and mirror state.

The cross-service transaction gap remains. The normal release flow activates
the mirror and promotes the GitHub release in separate workflow steps. The
current mirror record contains release assets and channel state, but no durable
pair recording promotion state, prior channel version, or restart-safe
reconciliation decision. A process exit or lost GitHub response between the two
steps therefore still needs the bounded transaction work described by #522.

The local mirror suite passed the publisher's upload, retry, conditional-write,
drill-isolation, same-tag, and supplemental-asset cases. It does not prove a
real GitHub promotion interruption or a restart against live service state.

## #551, stale suppression finding

The three historical unexplained large-file suppressions are not present in the
reviewed source:

| Historical owner | Current state |
| --- | --- |
| PDF text-layer renderer | The renderer path remains in use, and it has no `max-lines` suppression. |
| `scripts/architecture/boundary-check.mjs` | File remains, but has no `max-lines` suppression. |
| `scripts/diagnostics/scan-cleanup-representative-audit.mjs` | File remains, but has no `max-lines` suppression. |

The current repository search finds no source `max-lines` directive. This is a
qualification of an already-resolved finding, with no line-limit change, source
move, or new suppression.

## Checks

These existing checks passed on `876be7914`:

```text
pnpm exec vitest run tests/unit/scripts/publishReleaseMirror.test.ts tests/unit/scripts/releasePolicy.test.ts tests/unit/scripts/releaseStatus.test.ts tests/unit/scripts/ciTopologyPolicy.test.ts --reporter=dot
4 test files passed, 97 tests passed
```

The direct source audit also passed. `node --check` accepted both executable
audit scripts, and the repository contains no `max-lines` suppression
directive.

The locale and suppression evidence is recorded in
`docs/project8-locale-equality-review-2026-09-11.md` and this file. Live
Windows ARM64 acceptance and live cross-service promotion interruption remain
outside this VPS lane. No browser, OCR, assistant, or native source was edited.
