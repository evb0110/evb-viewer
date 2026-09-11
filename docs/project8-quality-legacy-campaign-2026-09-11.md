# Project 8 quality and legacy campaign receipt

Review date: 2026-09-11

Reviewed source: `876be7914` (`origin/project8/integration`)

This receipt covers the requested continuation set: #333, #375-378,
#420-423, #477-478, #521-522, and #526-568. It records what the integration
tip already contains. It does not close issues or turn unavailable hosted
acceptance into a local pass.

## Source disposition

| Area | Current evidence on this tip | Remaining gap |
| --- | --- | --- |
| #333, #535 | Registration table and reverse-disposal qualification are recorded in `docs/project8-registration-lifecycle-qualification-2026-09-11.md`. | Electron smoke and exact integrated CI remain coordinator evidence. |
| #375-378 | Worktree ownership is hardened by `3f5403a61`; bounded Electron startup and no-replay behavior by `791622444`; Windows lease recovery by `ec7126aca` and `f0219a948`; colored warning headers by `2353dce58`. | Windows lab restart and host-platform acceptance were not available in this VPS lane. |
| #420-423 | Diagnostics revocation and delayed-send fencing are in `dec477ac0` and `d64e195a5`; successful-response accounting is in `8337b8fa4`; incompatible crash markers are fenced by `20821f18c`. | Live multi-tab hosted diagnostics and GitHub/Windows platform runs remain external evidence. |
| #477-478 | Native batch growth is bounded by `4d8acfe04`; render-stage decomposition and its follow-up are in `8ad516919` and `f2b989a32`. | The large-document Electron performance lane (#552) is still red or unavailable here. |
| #521-522 | Windows ARM64 install proof is recorded in `docs/project8-quality-legacy-release-audit-2026-09-11.md`; release promotion has local safeguards. | No Windows ARM64 runner was available. Cross-service mirror/GitHub interruption recovery still needs hosted proof and durable transaction work. |
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

The coordinator should merge this receipt with the campaign branch and attach
the hosted/platform results listed above. The issues remain open.
