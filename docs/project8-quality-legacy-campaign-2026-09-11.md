# Project 8 quality and legacy campaign receipt

Review date: 2026-09-11

Reviewed source: `873c1621` (`origin/project8/integration`)

This receipt covers the requested continuation set: #333, #375-378,
#420-423, #477-478, #521-522, and #526-568. It records what the integration
tip already contains. It does not close issues or turn unavailable hosted
acceptance into a local pass.

## v5b fallback requalification

The #522 source qualification is evidenced by the authoritative
post-promotion-state branch and its `ciTopologyPolicy` regression. Its
configured isolated hosted drill also passed in run
[`34630569082`](https://github.com/evb0110/evb-viewer/actions/runs/34630569082)
at exact source `6fad2304d43594046c86d83c5885a262dd24fe85`. The drill passed
core promotion, both supplemental attachment passes, mirror verification, and
cleanup, which deleted 19 isolated mirror objects and left no drill draft
release. Production-service interruption/restart behavior and final artifact
digests remain coordinator evidence. The disjoint fallback, #551, is covered by this receipt:
the current source has no `max-lines` suppression directive, both executable
audit scripts pass `node --check`, and locale parity passes. The disjoint
register issue #568 remains accounting evidence:
all 60 supplemental recommendations retain an explicit disposition, linked
owner or follow-up, and a concrete reason for no action where applicable. The
register remains accounting evidence, not permission to create duplicate tests
or claim the hosted baseline is green.

## #566 operations and release register

The operations/release register remains a tracking receipt whose implementation
acceptance belongs to its linked issues. The current source review preserves
the existing #521 Windows ARM64 qualification and #522 release-promotion
qualification in the dedicated audit document. No row was silently converted
to Done, and no duplicate implementation ticket or release drill was created.
The unresolved rows remain visible through the Windows-runner and
cross-service-reconciliation gaps below.

The current integration CI run is `34634424961` for `873c1621`. It is pending
at receipt time, so no current-tip hosted pass is claimed. The immediately
prior run `34634319197` was cancelled before acceptance, while run
`34634223766` remains in progress. The separate
configured publish-chain
drill is terminal-successful in run `34630569082`; no terminal current-tip
release artifact digest is claimed here.

## #568 supplemental recommendation and CI register

The 60 supplemental recommendations remain accounted for with explicit
dispositions, linked owners or follow-ups, and reasons for no action. This
receipt updates only the dated CI evidence: run `34634009652` completed
cancelled for integration tip `8585fe08`, while run `34633711377` was also
cancelled before terminal acceptance. No supplemental implementation issue was
duplicated, and no issue or tracker state was changed.

The #566 operations/release register therefore remains open for the exact
current-tip ARM64 installed rerun and final artifact-digest evidence. The
cancelled CI result is recorded as a gap, not as acceptance.

## Source disposition

| Area | Current evidence on this tip | Remaining gap |
| --- | --- | --- |
| #333, #535 | Registration table and reverse-disposal qualification are recorded in `docs/project8-registration-lifecycle-qualification-2026-09-11.md`. | Electron smoke and exact integrated CI remain coordinator evidence. |
| #375-378 | Worktree ownership is hardened by `3f5403a61`; bounded Electron startup and no-replay behavior by `791622444`; Windows lease recovery by `ec7126aca` and `f0219a948`; colored warning headers by `2353dce58`. | Windows lab restart and host-platform acceptance were not available in this VPS lane. |
| #420-423 | Diagnostics revocation and delayed-send fencing are in `dec477ac0` and `d64e195a5`; successful-response accounting is in `8337b8fa4`; incompatible crash markers are fenced by `20821f18c`. | Live multi-tab hosted diagnostics and GitHub/Windows platform runs remain external evidence. |
| #477-478 | Native batch growth is bounded by `4d8acfe04`; render-stage decomposition and its follow-up are in `8ad516919` and `f2b989a32`. | The large-document Electron performance lane (#552) is still red or unavailable here. |
| #521-522 | Hosted run `34617444334` passed the Windows 11 ARM64 NSIS installed journey and both ARM64 Store installed-smoke jobs; release promotion has local safeguards. Configured hosted drill `34630569082` passed core promotion, supplemental attachment, mirror verification, and isolated cleanup at exact source `6fad2304`. | The exact current-tip ARM64 rerun and final artifact-digest acceptance remain coordinator evidence. Production-service interruption recovery still needs durable transaction work. |
| #526-534 | Shared fixture result/backend/event work and portable catalog, namespace, encoder, host, and runtime boundaries are present in the integration history. | The full tooling and platform CI selections were not run in this slot. |
| #536-538 | Fuzz-lock, acceptance-selection, and locale/scope evidence are recorded in the existing Project 8 qualification docs. | `cargo-deny` is not installed here; full acceptance-project and hosted coverage evidence remains coordinator-owned. |
| #539-551 | Existing assistant, browser, release, locale, icon, error-ID, and suppression repairs are present; prior qualification docs record the bounded checks. | Browser/Electron visual acceptance and hosted exact-SHA receipts remain outside this lane. |
| #552-568 | The source and prior campaign commits cover the detailed assistant, OCR, document, format, operation, release, settings, and accessibility work. | #552 and the platform-specific acceptance items still need their configured hosted or headed runs. #563-568 are accounting/receipt issues, not permission to invent duplicate tests. |

## Local checks

After the normal locked workspace setup (`pnpm install --frozen-lockfile`),
the focused regression set passed:

```text
19 test files passed
196 tests passed
```

The run covered worktree pruning, Electron session timeout/retry behavior,
startup crash markers, feature registration and shutdown ordering, diagnostics
consent and transport, browser settings and worker cleanup, assistant fencing,
document service and print behavior, recent files, search budgets and
cancellation, and updater artifact integrity.

The earlier Project 8 receipts also record these passing checks:

- registration lifecycle: 14 tests
- fuzz lock metadata and compilation
- acceptance selection policy: 54 tests
- release and mirror policy: 97 tests
- locale parity and localization: 22 tests

## Cleanup and handoff

No tracked generated files, source suppressions, issue state, or unrelated
worktree were changed. The dependency install only populated ignored workspace
dependencies. No browser, Electron app, Windows VM, hosted release, or GitHub
promotion was launched from this lane.

The coordinator should attach the terminal hosted/platform results to the
fallback receipt before changing its tracker status. The issues remain open.
