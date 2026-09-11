# Project 8 quality and legacy release audit

Review date: 2026-09-11

Source under review: `36a46412` (`origin/project8/integration`)

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

Hosted run [34617444334](https://github.com/evb0110/evb-viewer/actions/runs/34617444334)
at `e77c8500e1fcc74f0b9e9bce1fd1ab0c09d853e8` passed the Windows 11 ARM64
NSIS package job, including the installed Windows NSIS journey, and passed both
Windows 11 ARM64 Store installed-smoke jobs. That SHA is an ancestor of the
reviewed integration tip. The later source commit `19830bd36` binds Windows
artifact readiness to the NSIS journey outcome, and is also present in the
reviewed tip.

This qualifies the installed ARM64 behavior and the source gate, but the exact
current-tip hosted rerun has not completed in this campaign. Release publication
and final artifact-digest acceptance remain coordinator evidence.

## #522, mirror and GitHub promotion ordering

The publisher has useful local safeguards. It uploads and verifies immutable
release objects before changing the mutable channel, uses conditional channel
writes, keeps drill prefixes isolated, and restores the previous channel after
a publisher-owned channel mutation fails. The release status command reports
GitHub release visibility, assets, workflow results, and mirror state.

The source-level lost-response guard is present. After `gh release edit` fails,
the workflow rereads authoritative GitHub state and treats a public matching
release as success, a remaining draft as a failed promotion, and an unreadable
state as unresolved without changing the mirror channel. Commit `ea91cd36a`
introduced this behavior, and `tests/unit/scripts/ciTopologyPolicy.test.ts`
asserts the exact workflow branch on the reviewed tip.

The configured isolated interruption/restart/concurrency drill passed in
workflow run [`34630569082`](https://github.com/evb0110/evb-viewer/actions/runs/34630569082)
at exact source `6fad2304d43594046c86d83c5885a262dd24fe85`. Seeding,
immutable-asset finalization, mirror staging, promotion, both supplemental
attachment passes, mirror verification, and cleanup succeeded. The cleanup
job deleted 19 drill mirror objects under
`evb-viewer/drill/34630569082/`, and a post-run release query found no
`v0.0.0-drill.*` draft remaining.

The cross-service transaction gap remains for the normal release flow. It
activates the mirror and promotes the GitHub release in separate workflow
steps. There is
still no durable pair recording promotion state, prior channel version, or
restart-safe reconciliation decision. A process exit between the two steps
still needs the bounded transaction work described by #522.

The local mirror suite and the configured hosted drill passed the publisher's
upload, retry, conditional-write, drill-isolation, same-tag, and
supplemental-asset cases. The drill used isolated state and did not change a
production release channel. It does not prove a real production GitHub
promotion interruption or a restart against live service state.

## #551, stale suppression finding

The three historical unexplained large-file suppressions are not present in the
reviewed source:

| Historical owner | Current state |
| --- | --- |
| PDF text-layer renderer | The renderer path remains in use, and it has no `max-lines` suppression. |
| `scripts/architecture/boundary-check.mjs` | File remains, but has no `max-lines` suppression. |
| `scripts/diagnostics/scan-cleanup-representative-audit.mjs` | File remains, but has no `max-lines` suppression. |

The current repository search at `ff9bcaf6815d6299fb7e9b8eafb8b32290fb2201`
finds no source `max-lines` directive. `node --check` accepts both executable
audit scripts. This is a qualification of an already-resolved finding, with no
line-limit change, source move, or new suppression.

## Checks

These existing checks passed on `6fad2304` with release-owned inputs unchanged
since the prior qualification:

```text
pnpm exec vitest run tests/unit/scripts/publishReleaseMirror.test.ts tests/unit/scripts/releasePolicy.test.ts tests/unit/scripts/releaseStatus.test.ts tests/unit/scripts/ciTopologyPolicy.test.ts --reporter=dot
4 test files passed, 97 tests passed
```

The #522 source qualification is covered by the `ciTopologyPolicy` test in
that run. The configured isolated hosted drill passed in run `34630569082`.
Production-service interruption/restart behavior and final artifact-digest
acceptance remain coordinator-owned evidence.

The direct source audit also passed on the current integration tip. The locale
parity check passed for desktop package locales, and the repository contains no
`max-lines` suppression directive.

The locale and suppression evidence is recorded in
`docs/project8-locale-equality-review-2026-09-11.md` and this file. Live
Windows ARM64 acceptance and live cross-service promotion interruption remain
outside this VPS lane. No browser, OCR, assistant, or native source was edited.
