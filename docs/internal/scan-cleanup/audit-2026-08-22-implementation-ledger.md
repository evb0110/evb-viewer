# Scan cleanup audit implementation ledger

Date: 2026-08-23

Source: `docs/internal/scan-cleanup/audit-2026-08-22-verification-ledger.md`

## Purpose

This ledger converts the verified audit into bounded implementation packages.
It is a plan and closure record, not proof that any finding has been fixed.
Every unchecked item remains open.

The ledger separates four kinds of work:

- Ready work has a verified product path, a chosen owner, and testable closure.
- Evidence-first work starts with a fixture. Code changes follow only if the
  fixture proves behavior outside the accepted tolerance.
- Opportunistic work belongs in the next change to the named owner. It does not
  justify opening that owner by itself.
- Trigger-gated work stays unchanged until the recorded product or operational
  condition becomes true.

## Baseline and publication boundary

- Planning baseline: local `main` and refreshed `origin/main` at
  `ab53d0a8fb81ff101bf4c2467a42082c1347652c`.
- The checkout was clean before this untracked implementation ledger was
  created. The verification ledger is tracked at the baseline commit.
- Opus 5 High and Fable 5 High re-verified the implementation references against
  this baseline. They are not inherited only from the verification ledger's
  older source snapshot.
- Refresh the remote and record the current baseline SHA before starting each
  code package. Reconcile any later divergence without losing unrelated user
  work.
- Implement each package directly on `main` under the current repository rules.
  Do not combine independent packages merely to reduce the number of commits.
- This planning task changes documentation only. It does not authorize marking
  any package complete, changing product code, or publishing a fix.

## State vocabulary

| State | Meaning |
| --- | --- |
| Ready | Design and acceptance boundary are concrete enough to implement. |
| Evidence first | Land or run the oracle before deciding whether production code must change. |
| Opportunistic | Implement only while the named owner is already changing. |
| Trigger gated | Implement only after the recorded condition becomes true. |
| No code | Preserve the current implementation. Keep the evidence. |
| Invariant | A safety property that every touching package must preserve. |
| In progress | An implementation commit exists but closure gates are incomplete. |
| Blocked | A named external decision or failing prerequisite prevents safe work. |
| Verified | Acceptance checks, repository gates, review, publication, and CI evidence are recorded. |

Only `Verified` closes a package. A local green test or an implementation commit
alone does not.

## Program invariants

Every package that touches scan cleanup must preserve these properties:

1. Native manifest and NDJSON decoding stay bounded and fail closed on stale or
   unknown protocol shapes.
2. Output publication remains transactional across error, cancel, and panic.
3. A canceled or superseded job cannot publish or claim a generated document.
4. FIFO admission stays ordered and bounded. A future reader cannot occupy the
   worker pool ahead of the current producer.
5. Renderer ownership remains capability-scoped. Crash cancels active work;
   navigation detaches only where the current lifecycle deliberately allows it.
6. Output access grants remain time-bounded and are released on owner lifecycle
   events.
7. Preview, lossless final, and raster final describe the same physical page
   placement within the declared raster-grid tolerance.
8. User-facing warning formatting remains in TypeScript. Native code reports
   structured facts and bounded diagnostic detail. Adopting `t()` and paired
   English and Russian messages is a separate copy and localization change.
9. Geometry validation occurs where untrusted or injectable geometry enters.
   Do not add repeated validation inside the same trusted process path.
10. New layers replace an old owner. They do not leave a second state container,
    wrapper ladder, or compatibility path without a removal condition.

## Master implementation ledger

| Package | Findings | Priority | State | Depends on | Primary owner | Closure summary |
| --- | --- | --- | --- | --- | --- | --- |
| SC-IMP-001 | C5 | P1 | Ready | Baseline reconciliation | Manifest construction and native CLI boundary | Every runnable product manifest is root-constrained against symlink escapes at both process boundaries. |
| SC-IMP-002 | E3 | P1 | Ready | Baseline reconciliation | Document-open lifecycle | Generated-PDF opening has a real cancelable deadline and cannot complete late after the run guard clears. |
| SC-IMP-003 | C2 | P2 | Ready | SC-IMP-001 and SC-IMP-002 may land independently | Scan-cleanup warning contract | No production behavior parses English warning text; all three paths emit equivalent structured warnings. |
| SC-IMP-004 | C1 | P2 | Evidence first | SC-IMP-003 | Matched-canvas placement policy | Shared fixtures prove parity; production fitting changes only for a measured out-of-tolerance case. |
| SC-IMP-005 | C3 | P2 | Ready | None | PDF page-geometry admission | Every positional consumer receives canonical `1..N` geometry or a loud boundary failure. |
| SC-IMP-006 | C6 | P2 | Ready | None | Rust `PageStageTimings` | Reconciliation uses one exhaustive addition owner and a new field cannot be omitted silently. |
| SC-IMP-007 | C4 | P3 | Opportunistic | Next sidecar callback change | Sidecar progress adapter | The adapter exposes transport facts; workflow owners define presentation progress. |
| SC-IMP-008 | N2 | P3 | Opportunistic | Next fixed-analysis-input change | Native manifest decoding | Fixed analysis raster and DPI are consumed as one validated value. |
| SC-IMP-009 | N4 | P3 | Opportunistic | Next scheduler change | Native page scheduler | Stream classification is captured once after FIFO creation and reused. |
| SC-IMP-010 | T1 | P3 | Ready, small | None | Lossless sidecar consumer | Native totals are checked against the submitted page scope before indexing. |
| SC-IMP-011 | T2, T3 | P3 | Opportunistic | Next edit to each named function | Core diagnostics and lossless plan | Remove a constant log token and reuse the resolved DPI without behavior change. |
| SC-IMP-012 | T4 | P3 | Trigger gated | A supported run can approach 24 hours | Scratch lifecycle | Ordinary run roots gain explicit liveness only if measured duration makes mtime insufficient. |
| SC-IMP-013 | E1 | No action | Trigger gated | A second request builder or direct caller appears | Scan-cleanup request identity | Equivalent normalized requests join the same job regardless of input representation. |
| SC-IMP-014 | N1 | P3 | Trigger gated | Placement consolidation resumes | Native batch adapter | Move one complete responsibility and delete the corresponding facade or old owner. |
| SC-IMP-015 | N5 | No action | Trigger gated | Same-process concurrent manifest API appears | Native materialized stream storage | Per-run names use exclusive creation and a run nonce. |
| SC-NOCHANGE-001 | N3 | None | No code | None | Native manifest path admission | Preserve the reachable Unicode JSON boundary; do not implement the refuted bypass fix. |
| SC-NOCHANGE-002 | E2 | None | No code | None | Renderer processed-page semantics | Preserve terminal-state clearing; treat active badges as processing completion. |
| SC-INVARIANT-001 | N6 | Positive | Invariant | All native packages | Native validation and publication | Alias checks, rollback, panic recovery, bounds, and FIFO ordering remain green. |
| SC-INVARIANT-002 | E4 | Positive | Invariant | SC-IMP-002 and service changes | Electron owner lifecycle | Capability TTL, crash cancellation, navigation policy, and bounded replay remain green. |

### Adjacent issue boundary

| Boundary | Source | Product priority | State | Current scan-cleanup reachability | Decision |
| --- | --- | --- | --- | --- | --- |
| SC-BOUNDARY-001 | GitHub #81 | P3 | Open, separate package | None. The affected symbol decoder is not used by the default scan-cleanup path. | Retain the evidence and test plan here, but track implementation and closure as independent JBIG2 hardening. |

## Dependency and landing order

The safe landing order is:

1. Reconcile `main` with the current remote and rerun the 77-test verification
   baseline from the source ledger.
2. Land SC-IMP-001 and SC-IMP-002 as separate P1 commits. They touch different
   lifecycle owners and can be reviewed independently.
3. Land SC-IMP-003 before SC-IMP-004. Structured warning codes become part of
   the matched-canvas parity oracle.
4. Land SC-IMP-005, SC-IMP-006, and SC-IMP-010 as separate small hardening
   commits. They have no dependency on placement behavior.
5. Take SC-IMP-007 through SC-IMP-015 only when their recorded trigger is met.

SC-BOUNDARY-001 is not part of the landing order. It remains visible because it
shares native release gates, but it does not compete with or block the verified
scan-cleanup packages.

Do not land C1 fitter changes in the same commit as its fixture. The first C1
commit must establish the oracle against unchanged behavior. If all cases pass,
close the evidence question and leave the three implementations unchanged.

## Common definition of ready

Before changing code in any package:

- [ ] `main` is clean and matches or contains the current `origin/main` without
  unresolved divergence.
- [ ] The package records its implementation baseline SHA.
- [ ] The verification ledger evidence still matches the named source paths.
- [ ] Existing unrelated user changes are identified and preserved.
- [ ] The package has one behavior owner and a stated deletion or migration
  boundary for any temporary compatibility path.
- [ ] The targeted test command passes before the first production edit.
- [ ] The package names its user-visible failure, or explicitly says it is
  defense in depth or maintenance hardening.

## Common definition of done

For every implemented package:

- [ ] Targeted regression tests fail on the old behavior when a defect is
  reproducible, or the package records why the evidence is static-only.
- [ ] Targeted tests pass after the change.
- [ ] `pnpm run validate:iteration` passes.
- [ ] Rust changes pass `pnpm run lint:rust` and the applicable native library
  and `page_cli` integration targets.
- [ ] Contract changes pass codec fixtures, feature IPC fixtures, TypeScript
  typecheck, and native protocol fixtures where applicable.
- [ ] Placement or generated-PDF behavior changes have one real-app proof and
  saved artifacts when the package calls for them.
- [ ] CodeRabbit CLI review against `main` is completed within the repository's
  pass limit, or the fail-open reason is recorded after normal verification.
- [ ] The implementation is committed on `main` with a message that states why
  the change matters.
- [ ] `node scripts/review-cubic-commits.mjs --commit HEAD` is run before push;
  useful findings are fixed and the commit is amended.
- [ ] The effective diff is re-reviewed if a CodeRabbit or Cubic fix changes it.
- [ ] `main` is reconciled with the latest remote immediately before push.
- [ ] Required CI passes on the published commit.
- [ ] Closure record contains commit SHA, CI URL or run ID, commands and exact
  results, review dispositions, artifacts and checksums, remaining non-goals,
  and the next package now unblocked.

## SC-IMP-001, constrain runnable native manifests

Findings: C5. Priority: P1. State: Ready.

### Outcome and user impact

Every native manifest launched by the product is constrained to the
process-owned temporary root in both TypeScript and Rust. A symlink or
symlinked ancestor inside that root cannot redirect an input, metadata file, or
output outside it. Geometry-only validation and the general-purpose native CLI
keep their current behavior.

The source PDF opened by Poppler is not a native manifest path and must not be
pulled into this root policy.

### Selected design

Keep the trusted root out of protocol-v3 JSON. The parent process owns the root
and passes it separately to the native CLI:

```text
process-owned temp root
  -> runnable manifest builder canonicalizes every path
  -> sidecar argv adds --allowed-path-root <root>
  -> native canonicalizes the root and every manifest path
  -> native rejects escapes before transaction creation or execution
```

Use one internal manifest assembly implementation with two explicit public
entry points:

- The runnable entry point requires `allowedPathRoot` at compile time.
- The geometry-only entry point performs shape and geometry validation without
  checking placeholder paths. Only the preflight at
  `runScanCleanupConversion.ts:752-789` may use it.

Do not retain an optional root on the runnable API. Do not put a self-asserted
root in `ManifestV3`.

### TypeScript ownership and anticipated diff

Core policy:

- `scan-cleanup-core/assertScanCleanupPathWithinRoot.ts:1-24`
- `scan-cleanup-core/policy/buildNativeScanCleanupManifest.ts:55-339`
- `scan-cleanup-core/index.ts`
- `scan-cleanup-core/runScanCleanupConversion.ts:752-789`

The synchronous containment helper must:

1. Require absolute root and candidate paths.
2. Require and canonicalize the root.
3. Walk a candidate to its deepest existing ancestor.
4. Canonicalize that ancestor and append missing descendants.
5. Compare the canonical candidate with the canonical root.
6. Reject dangling or unresolved symlink segments.
7. Accept a missing output below a real existing parent.
8. Accept a symlink that resolves inside the root, subject to the existing file
   and destination rules.
9. Preserve `ScanCleanupContractError` and stable labels.

Do not import Electron-only path utilities into core. Useful implementations
to inspect, without creating a dependency, are
`electron/utils/pathValidator.ts:113-160` and
`electron/file-access/documentFileWriteAtomic.ts:53-136`.

Runnable builders that must pass an explicit root:

- Detection at `scan-cleanup-core/detection.ts:531-605`, using
  `dependencies.getTempDir()`.
- Lossless analysis at `scan-cleanup-core/runLosslessScanCleanup.ts:112-169`,
  using `paths.tempDir`.
- Raster final at `scan-cleanup-core/runScanCleanupConversion.ts:922-1018`,
  using `paths.tempDir`.
- Detail preview at
  `electron/features/scan-cleanup/createScanCleanupPreviewService.ts:1686-1703`,
  using `dependencies.getTempDir()`.
- Ordinary preview at
  `electron/features/scan-cleanup/createScanCleanupPreviewService.ts:2125-2176`,
  using `dependencies.getTempDir()`.

The wider temp root is intentional. Detection, lossless, and preview may refer
to retained analysis rasters or trusted layers outside the manifest's immediate
scratch directory but still below the app-owned temp root.

Diagnostic producers are part of the runnable inventory:

- `scripts/diagnostics/scan-cleanup-corpus-verify.mjs:967-1053` and
  1297-1498. Use the fixture directory for each manifest and command.
- `scripts/diagnostics/scan-cleanup-preview-harness.mjs:890-1109`. Use each
  page directory for normal and provisional manifests.

### Sidecar and native boundary

Add `allowedPathRoot?: string` to `IRunScanCleanupSidecarOptions` at
`electron/features/scan-cleanup/worker/runScanCleanupSidecar.ts:36-42`.
Append `--allowed-path-root <root>` at the manifest argv construction around
lines 124-131 only when supplied. Every product caller listed above must supply
the same root used by its builder.

In `native/scan-cleanup/src/adapters/batch_cli.rs`:

- Extend the manifest CLI invocation to carry an optional trusted root.
- Accept `--allowed-path-root` only with `--manifest`.
- Keep `--manifest <path>` without the flag valid for external CLI users.
- Keep direct `--input`, `--output`, and `--metadata` mode unchanged.
- Before transaction creation, compare every `ManifestV3::input_paths()` and
  `destination_paths()` entry with the canonical root.
- Reuse or extract `resolved_manifest_path` at lines 1602-1630 so missing
  outputs and symlinked ancestors follow one rule.
- Run the existing alias, destination identity, and regular-file validation
  after containment. Do not weaken or duplicate it.

Do not change `native/scan-cleanup/src/protocol/manifest_v3.rs`, the protocol
version, or manifest golden JSON for the trusted-root transport.

### Compatibility and non-goals

- Direct native mode remains unrestricted by a root flag.
- The direct-mode OCR consumer at
  `electron/ocr/worker/tryPreprocessOcrImage.ts:136-152` remains valid without a
  root.
- Rootless external `--manifest` calls remain valid.
- Product sidecar calls must never be rootless after this package.
- FIFO inputs and not-yet-created outputs remain valid when their resolved
  ancestors stay inside the root.
- Geometry-only preflight remains cheap and path-independent.
- This package does not move the source PDF or broaden the temp root.
- This package does not claim to sandbox a hostile native binary.

### Commit sequence

1. Add canonical deepest-existing-ancestor logic and filesystem-backed tests.
2. Add the geometry-only public entry point, backed by the same internal
   assembly implementation, and move the conversion preflight to it.
3. Require a root in the runnable builder and migrate all core, preview, and
   diagnostic callers.
4. Add the sidecar option and prove builder root equals native argv root.
5. Add native CLI parsing and pre-transaction containment with parser and
   integration tests.
6. Re-scan builder, sidecar, and direct `--manifest` call sites before review.

These may be one reviewed package. No published commit may require a root in
the runnable builder while any product caller still omits it.

### Test plan

TypeScript tests:

- `tests/unit/electron/scanCleanupNativeManifestBuilder.test.ts`
  - existing input and output inside a canonical root;
  - existing input symlink to outside;
  - missing output below a symlinked directory to outside;
  - missing output below a real directory;
  - symlink that resolves inside;
  - nonabsolute candidate and root;
  - macOS `/var` and `/private/var` canonical equivalence;
  - geometry-only placeholders never enter path validation.
- `tests/unit/electron/scanCleanupPreview.test.ts`
  - both preview modes capture the injected temp root;
  - retained base-analysis inputs remain accepted;
  - sidecar options carry the same root as the builder.
- `tests/unit/electron/scanCleanupDetection.test.ts`
  - Analyze manifest and sidecar invocation share the temp root.
- `tests/unit/electron/scanCleanupPipeline.test.ts`
  - lossless and raster-final manifests use the fixture temp root;
  - geometry failures stay independent of runnable path validation.
- Script tests for the corpus verifier and preview harness pin their scoped
  roots and CLI arguments.

Native tests:

- Manifest with and without `--allowed-path-root`.
- Root flag combined with direct mode is rejected.
- Missing or nondirectory root is rejected.
- Existing symlink input to outside is rejected.
- Missing output below a symlinked external ancestor is rejected.
- Missing output below a real root directory is accepted.
- FIFO input inside the root remains accepted.
- The real CLI rejects an escape before writes or transaction backups begin.
- Existing hardlink alias, rollback, panic, and stream-order tests remain green.

Focused commands:

```sh
pnpm exec vitest run \
  tests/unit/electron/scanCleanupNativeManifestBuilder.test.ts \
  tests/unit/electron/scanCleanupPreview.test.ts \
  tests/unit/electron/scanCleanupDetection.test.ts \
  tests/unit/electron/scanCleanupPipeline.test.ts

cargo test --manifest-path native/Cargo.toml -p evb-scan-cleanup --lib manifest -- --nocapture
cargo test --manifest-path native/Cargo.toml -p evb-scan-cleanup --test page_cli -- --nocapture
cargo test --manifest-path native/Cargo.toml -p evb-scan-cleanup --test strict_cli_flags -- --nocapture
```

Extend `strict_cli_flags.rs` in the same package because it pins real-binary
argument errors. Keep `protocol_version.rs` green; it reads the generated
descriptor rather than pinning a literal scan-cleanup revision.

### Stop and rollback signals

Stop before publication if:

- geometry preflight checks empty placeholder paths;
- a valid FIFO or missing output is rejected;
- any product sidecar call omits the root;
- a root appears in manifest JSON;
- direct CLI behavior now requires a root;
- preview detail rejects retained analysis paths under the wider temp root;
- an escape is detected only after transaction creation;
- macOS canonical aliases reject a valid path;
- alias, rollback, panic, or ordered-stream tests regress.

### Package closure record

- [ ] Implementation baseline SHA recorded.
- [ ] Runnable builder has no optional-root path.
- [ ] Geometry-only construction has one caller category and no runnable use.
- [ ] Product manifests and native argv carry the same trusted root.
- [ ] Protocol v3 JSON and direct CLI compatibility are unchanged.
- [ ] TypeScript and native symlink tests pass.
- [ ] FIFO, missing-output, alias, rollback, panic, and preview tests pass.
- [ ] Targeted and common gates pass.
- [ ] CodeRabbit, Cubic, commit, push, and CI evidence recorded.

## SC-IMP-002, bound and cancel generated-PDF opening

Findings: E3. Priority: P1. State: Ready.

### Outcome and user impact

Opening the generated PDF has a real deadline. Timeout, renderer disposal, or
run cancellation reaches the main-process document-open operation. A late
working-copy result cannot open a tab, clear a newer run, or remain registered
without an owner. A successful open still uses the authoritative main-process
working-copy result before the workspace claims the document.

### Existing lifecycle and selected design

The coordinator deliberately retains its completed-run guard while
`openGeneratedPdf()` runs at
`app/modules/scan-cleanup/runtime/scanCleanupRunCoordinator.ts:309-341`.
The renderer dependency calls `openDocumentDirect(path)` and then
`handleOpenInNewTab(result)` at
`app/modules/workspace-shell/composables/useScanCleanupRunCoordinator.ts:64-88`.
The direct IPC call has no request ID, cancellation channel, or timeout.

Reuse the existing cancellable batch-open protocol for the single generated
PDF:

```text
terminal scan result
  -> coordinator creates a bounded handoff AbortSignal
  -> renderer calls openDocumentDirectBatch([path], requestId)
  -> abort sends cancelOpenDocumentDirectBatch(requestId)
  -> main aborts admission or suppresses and cleans a late working copy
  -> live result is passed to handleOpenInNewTab(result)
```

Do not replace the result with `handleOpenInNewTab(path)`. The result-first
handoff is the ownership boundary that lets main create and register the
working copy before the workspace starts its transaction.

Keep ordinary `openDocumentDirect(path)` unchanged for other callers. Do not
add a duplicate direct-open cancellation protocol while the batch request ID
and cancel channel already cover a one-item request.

### Coordinator ownership

In `scanCleanupRunCoordinator.ts`:

- Change the `openGeneratedPdf` dependency to accept an `AbortSignal`.
- Create one controller and one named deadline for each terminal handoff. Use
  the implementation-time document-open deadline, aligned with the existing
  bounded document-open stage unless measured evidence calls for a different
  value.
- Race the dependency with the signal so timeout and rejection always release
  the completed-run guard.
- Keep the guard until the result-based tab claim finishes on success.
- Add a handoff generation or token. A late promise cannot clear a newer run,
  show a notification through newer dependencies, or navigate.
- On disposal, abort and invalidate the handoff but preserve persisted active
  job state so a new renderer installation can reconcile and replay it.
- On ordinary timeout or rejection, clear `activeJobId`, `inFlight`, and
  session persistence exactly once, matching current terminal failure cleanup.

The existing `terminalJobs` reservation may remain, but disposal must release
the still-pending reservation for a later installation.

### Renderer and main-process ownership

In `useScanCleanupRunCoordinator.ts`:

- Generate a request ID and call `openDocumentDirectBatch([path], requestId)`.
- Register abort to call the optional
  `cancelOpenDocumentDirectBatch(requestId)` capability.
- Race locally as a compatibility fallback if an older browser capability lacks
  cancellation, and consume the late promise to avoid an unhandled rejection.
- Call `handleOpenInNewTab(result)` only while the handoff token is live.
- If a PDF result arrives after abort and no tab claim began, clean only its
  managed working copy through the document working-copy capability. Never
  delete the generated source output.

In `electron/features/documents/main/documentOpenHandlers.ts`:

- Generalize the active batch-combine map to active sender-scoped requests.
- Create an abort controller for every normalized batch request ID, including a
  single PDF without `forceCombine`.
- Remove the map entry in `finally` and reject cross-sender cancellation.
- If cancellation wins while an uninterruptible copy is finishing, return the
  abort result and let the operation clean its eventual working copy.

In `electron/features/documents/main/openInputPaths.service.ts`:

- Apply the existing open-input abort lifecycle to the single-PDF branch before
  `stat`, broker admission, and working-copy creation.
- Compose it with the current 15-second broker admission timeout.
- Check the signal before creation, immediately after creation, before touching
  generated-output retention, and before returning the result.
- Always release the broker lease.
- If abort or failure occurs after a copy exists but before result ownership is
  transferred, call `cleanupWorkingCopy(workingPath, ownerId)`.

Node copy and clone calls are not truly interruptible. Do not pretend otherwise
by throwing after registration without rolling back the working-copy entry,
revision sidecar state, and background materialization. The smallest safe
implementation lets the phase finish, suppresses its result, and performs the
owned cleanup.

### Compatibility and non-goals

- Preserve `TOpenFileResult` as the tab handoff value.
- Preserve generated-document marking, output-retention refresh, and exclusion
  from Recent Files.
- Preserve the current renderer-destroyed, render-process-gone, and navigation
  cancellation policy.
- The direct handler's Recent Files authorization fallback is not present on the
  batch handler. Generated scan-cleanup outputs are deliberately excluded from
  Recent Files, so this is a checked non-difference. A live generated-output
  capability grant must remain sufficient for the one-item batch call.
- Do not make optional browser cancellation capability mandatory.
- Do not redesign the workspace controller's separate source-stage timeout.
- Do not clear persisted active-job state merely because a component disposed.

### Test plan

Add or extend cases for:

- coordinator timeout aborts, clears the guard once, and permits another run;
- coordinator disposal invalidates the old handoff without clearing a newer
  installation, and a reinstalled coordinator can replay the terminal job;
- a late completion cannot notify, navigate, or clear newer state;
- renderer sends a request ID and the existing cancel call, never starts the
  tab claim after abort, and cleans an unclaimed late result;
- main cancellation aborts a single-PDF batch request without `forceCombine`;
- aborted broker admission never starts working-copy creation;
- abort during deferred copy returns no result and cleans the eventual managed
  copy;
- abort after copy but before retention touch cleans the copy and does not touch
  retention;
- normal generated opens retain result-first ownership and all current flags.
- sender-scoped handler cancellation in a new
  `tests/unit/electron/documentOpenHandlers.test.ts`; this is new coverage, not
  a pre-existing baseline target.

Preserve the existing guard, cold-open, stale-result, close-fence, controller
timeout, and single-open tests in these owners:

- `tests/unit/app/modules/scan-cleanup/scanCleanupRunCoordinator.test.ts`
- `tests/unit/app/modules/workspace-shell/composables/useScanCleanupRunCoordinator.test.ts`
- `tests/unit/app/modules/workspace-shell/composables/useAppShellWorkspaceRouting.test.ts`
- `tests/unit/app/modules/workspace-shell/viewers/scanCleanupWorkspaceReopenHandoff.test.ts`
- `tests/unit/app/modules/workspace-shell/host/deferredWorkspaceHostDocumentOpen.test.ts`
- `tests/unit/app/modules/workspace-shell/document-sessions/workspaceDocumentControllerQueue.test.ts`
- `tests/unit/app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow.test.ts`
- `tests/unit/electron/openInputPaths.test.ts`
- `tests/unit/electron/preloadCreateElectronApi.test.ts`
- `tests/unit/electron/inProcessIpcRoundTrip.test.ts`
- `tests/unit/electron/documentsIpcAdapter.test.ts`

Focused command:

```sh
pnpm exec vitest run \
  tests/unit/app/modules/scan-cleanup/scanCleanupRunCoordinator.test.ts \
  tests/unit/app/modules/workspace-shell/composables/useScanCleanupRunCoordinator.test.ts \
  tests/unit/app/modules/workspace-shell/viewers/scanCleanupWorkspaceReopenHandoff.test.ts \
  tests/unit/app/modules/workspace-shell/composables/useAppShellWorkspaceRouting.test.ts \
  tests/unit/app/modules/workspace-shell/host/deferredWorkspaceHostDocumentOpen.test.ts \
  tests/unit/electron/openInputPaths.test.ts \
  tests/unit/electron/documentsIpcAdapter.test.ts
```

Run the new `documentOpenHandlers.test.ts` separately after its first failing
regression is added. Existing handler behavior is also exercised by
`documentsOpenRecent.test.ts`, `documentOpenFolderLimits.test.ts`, and
`nativeMenuDialogRouting.test.ts`.

### Stop and rollback signals

- `handleOpenInNewTab` runs after abort.
- A canceled request returns a `TOpenFileResult` to the active caller.
- A canceled working copy or its revision and background-materialization state
  remains registered.
- Cancellation releases another request's broker lease or crosses senders.
- The run guard clears before the live result-based workspace claim.
- An old promise clears a newer coordinator installation.
- Browser capability validation fails because cancellation became required.
- The generated open loses access because the batch path does not honor its
  live capability grant.
- Cold-open ordering, navigation cancellation, combined-open cancellation, or
  workspace stale-fence tests regress.
- Cleanup deletes the generated source output instead of the unclaimed copy.

### Package closure record

- [ ] Deadline, request ID, and sender-scoped cancellation are recorded.
- [ ] Timeout, disposal, and late-result tests pass.
- [ ] Unclaimed working copies and their registration state are cleaned.
- [ ] Result-first workspace ownership and generated-output behavior stay green.
- [ ] E4 capability and renderer lifecycle invariants stay green.
- [ ] Targeted and common gates pass.
- [ ] CodeRabbit, Cubic, commit, push, and CI evidence recorded.

## SC-IMP-003, replace warning-string coupling with typed events

Findings: C2. Priority: P2. State: Ready.

### Outcome and user impact

Raster final, lossless final, and preview emit the same stable warning code for
the same matched-canvas condition. TypeScript aggregates by code. A wording or
localization change cannot silently turn one summary into per-page noise.

### Current owners

Warning authors include:

- Native matched-canvas placement at
  `native/scan-cleanup/src/adapters/batch_cli.rs:3700-3750`.
- Other native engine and fallback warnings carried by
  `CleanupMetadata.warnings` in `native/scan-cleanup/src/engine/render.rs:287`.
- Lossless placement at
  `scan-cleanup-core/runLosslessScanCleanup.ts:350-416`.
- Preview placement at
  `electron/features/scan-cleanup/createScanCleanupPreviewService.ts:2411-2426`.
- Other conversion and no-canvas warnings in
  `runScanCleanupConversion.ts:503-734` and
  `scan-cleanup-core/policy/documentCanvas.ts:397-405`.

The live string consumer is
`scan-cleanup-core/runScanCleanupConversion.ts:1415-1426`. It recognizes
native English with `startsWith` and `includes`, suppresses the matching
per-page text, and aggregates it at lines 1460-1466.

### Selected design

Add a bounded `warningEvents` array beside the existing diagnostic `warnings`
array in native output metadata. Each event has:

- a closed stable code union;
- only the typed numeric, page, dimension, side, or count parameters required
  by that code;
- contract limits for event count and string or numeric fields;
- no preformatted user text.

Condition ownership stays with the policy that detects the condition. A single
TypeScript formatter owns display and log text. Aggregation uses only codes and
parameters.

This package centralizes the current English wording without adopting `t()`.
A localization change requires paired English and Russian messages and separate
copy approval. It must not be smuggled into the warning transport migration.

The initial code matrix must cover every matched-canvas event currently written
by Rust, plus equivalent lossless and preview cases:

- content fitted inside the requested margin box;
- requested margins reduced;
- requested margins unavailable;
- paper placed below document scale;
- optical centering fallback;
- intrinsic horizontal overflow;
- spread headroom trim;
- fold-side trim;
- dropped or unavailable canvas;
- resampled page, normalized DPI, and capped DPI where those are part of the
  same summary contract.

Do not create codes for arbitrary debug prose. Unstructured diagnostics may
remain bounded strings if no program logic or UI depends on them.

### Runtime compatibility decision

Keep the public JSON manifest version at 3. Increment the scan-cleanup runtime
compatibility revision in `packages/contracts/nativeToolProtocols.ts` from its
implementation-time value and regenerate
`native/evb-native-support/src/generated_native_tool_protocols.rs` with
`scripts/generateNativeToolProtocols.ts`. This makes a stale bundled native
binary fail before Electron expects `warningEvents`.

The artifact decoder may accept missing events for historical artifacts, and
legacy `warnings: string[]` stays readable and logged. The current bundled
execution path must not parse English after this package. Any temporary
legacy-string fallback must name its artifact-only caller and removal condition.
It must not decide live raster aggregation.

Replacing `warnings` with objects is out of scope. That would require a public
wire-shape migration rather than this additive event channel.

### Anticipated diff

- `packages/contracts/scan-cleanup/nativeProtocolV3.ts`
  - event code union, per-code parameter types, bounded exact schema.
- `packages/contracts/scan-cleanup/nativeArtifactCodecs.ts`
  - optional event decoding and limits.
- `packages/contracts/nativeToolProtocols.ts` and generated Rust descriptor
  - runtime compatibility revision.
- `native/scan-cleanup/src/engine/render.rs` and
  `native/scan-cleanup/src/adapters/batch_cli.rs`
  - event storage and native emission beside diagnostic strings.
- `scan-cleanup-core/runLosslessScanCleanup.ts`
  - lossless event emission.
- `electron/features/scan-cleanup/createScanCleanupPreviewService.ts`
  - preview event emission and propagation.
- A shared TypeScript warning formatter in the existing scan-cleanup contract
  or core policy owner. Do not add a renderer-only duplicate.
- `scan-cleanup-core/runScanCleanupConversion.ts`
  - code-based aggregation and removal of English parsing.
- IPC summary or preview metadata codecs only if structured events cross that
  boundary. Keep raw events out of renderer state if only formatted text is
  consumed there.

### Commit sequence

1. Add event types, bounds, codecs, runtime compatibility revision, generated
   descriptor, and legacy artifact fixtures without changing behavior.
2. Emit events from native, lossless, and preview owners while preserving
   current diagnostic strings.
3. Switch raster aggregation and formatting to codes. Delete the English
   prefix parser.
4. Add cross-path event parity cases and prove existing displayed wording and
   aggregate counts remain unchanged.

Steps 1 and 2 may be separate commits. Do not publish a consumer that requires
events before the runtime compatibility revision and native producer land.

### Test matrix

- Contract tests reject unknown codes, wrong parameter shapes, too many events,
  nonfinite numbers, and oversized detail.
- Runtime protocol tests reject the previous native compatibility revision.
- Each native condition has an author test that asserts code and parameters.
- Lossless and preview tests assert the equivalent code where the condition is
  shared.
- Raster-final aggregation receives a native event and produces one aggregate
  with the correct page list.
- Changing native diagnostic wording in a fixture does not change aggregation.
- Legacy artifacts without events still decode under the explicitly bounded
  artifact path.
- Existing warning wording, page prefixes, pixel and point units, counts, and
  log severity remain pinned until a separately approved copy change.

Focused commands:

```sh
node --import tsx scripts/generateNativeToolProtocols.ts
pnpm exec vitest run \
  tests/unit/contracts/scanCleanupNativeArtifactCodecs.test.ts \
  tests/unit/electron/scanCleanupNativeProtocolCodec.test.ts \
  tests/unit/electron/scanCleanupPipeline.test.ts \
  tests/unit/electron/scanCleanupPreview.test.ts
cargo test --manifest-path native/Cargo.toml -p evb-scan-cleanup --lib batch_cli -- --nocapture
pnpm run typecheck
```

### Stop and rollback signals

- A current product path still branches on English text.
- A stale native binary passes the compatibility handshake but omits events.
- Existing artifacts fail to decode without an intentional format decision.
- A warning disappears, duplicates, changes severity, or changes aggregate
  page counts.
- Preview and final emit different codes for the same physical condition.
- Localization or formatting moves into Rust.
- Temporary dual representation has no named removal condition.

### Package closure record

- [ ] Complete code and parameter matrix attached.
- [ ] Current native, lossless, and preview producers emit structured events.
- [ ] Live aggregation contains no English parser.
- [ ] Runtime compatibility descriptor and generated Rust source match.
- [ ] Legacy artifact behavior and removal boundary are recorded.
- [ ] Display text and aggregation counts are unchanged unless separately
  approved.
- [ ] Targeted and common gates pass.
- [ ] CodeRabbit, Cubic, commit, push, and CI evidence recorded.

## SC-IMP-004, prove matched-canvas parity before changing fitters

Findings: C1. Priority: P2. State: Evidence first.

### Outcome

A shared fixture corpus compares physical fitted margins, content scale,
placement, and warning codes across raster final, lossless final, and preview.
The accepted delta is at most one raster canvas pixel at the selected canvas
DPI. Raw pixel and PDF-point decimals are not compared directly.

### Current fitters

- Native raster fitter at
  `native/scan-cleanup/src/adapters/batch_cli.rs:2774-2953` rounds to the final
  canvas pixel grid and leaves one drawable pixel.
- Lossless fitter at `scan-cleanup-core/runLosslessScanCleanup.ts:290-304`
  works in PDF points and leaves `0.01` point.
- Preview fitter at
  `electron/features/scan-cleanup/createScanCleanupPreviewService.ts:2207-2220`
  works on its pixel grid and leaves one pixel.

Existing unit cases stay useful. They do not form a cross-path oracle:

- Native placement cases at `batch_cli.rs:6095-6360`.
- Lossless cases in
  `tests/unit/electron/scanCleanupPipeline.test.ts:4787-5228`.
- Preview cases in
  `tests/unit/electron/scanCleanupPreview.test.ts:4874-4960`.

### Fixture and report design

Extend `tests/e2e/electron/quarantine/scanCleanupUniformity.e2e.test.ts` and its
existing app-to-CLI report. Do not build a second end-to-end runner.

Add normalized report fields for:

- requested and delivered physical margins;
- canvas and content rectangles in one physical unit;
- scale relative to document canvas;
- placement offsets and alignment;
- SC-IMP-003 warning codes and parameters;
- source DPI, canvas DPI, rotation, split half, and tolerance used.

Cases must cover zero and ordinary margins, exact boundary, over-constrained
axes, asymmetric margins, all rotations, split leaves, a spread with unequal
crops, a canvas narrower than the allowed margin pair, and paper larger than
the chosen canvas.

### Two-stage landing rule

Stage A changes tests and report generation only. Run it against unchanged
production code and retain the report plus fixture identities.

- If every path is within tolerance and warning decisions agree, close the
  evidence question. Do not refactor the fitters merely to make them look alike.
- If a case exceeds tolerance, open Stage B for that case. Change the smallest
  owning policy, keep the failing fixture unchanged, and prove unrelated cases
  remain stable.

Do not land a fitter change in the fixture commit. Do not replace physical
parity with byte identity.

### Verification

Run focused unit tests for all three owners, then the existing quarantine
uniformity and matched-canvas scenarios with tracked or checksum-recorded
fixtures. A Stage B behavior change also requires:

- native library and `page_cli` integration tests;
- `pnpm run build:native:e2e` and the one real-app proof;
- visual and semantic verification of the generated PDF;
- report and PDF SHA-256 identities in the closure record.

### Stop and rollback signals

- The test compares pixels with points without normalization.
- The tolerance changes per failing case.
- Warning codes disagree even when placement is within tolerance.
- App and CLI effective options or stream hashes change outside the target.
- A fix changes rotation, spread, asymmetric-margin, or split-leaf behavior not
  represented by the failing fixture.
- A fixture is generated but not retained or checksum-identified.

### Package closure record

- [ ] Stage A commit and unchanged-code report recorded.
- [ ] Every required case and physical normalization field is present.
- [ ] Tolerance is fixed at no more than one selected-DPI raster pixel.
- [ ] Warning-code parity is green.
- [ ] Stage B is marked unnecessary, or its failing case and narrow fix are
  recorded separately.
- [ ] Generated artifacts, checksums, tests, review, commit, CI, and remaining
  non-goals recorded.

## SC-IMP-005, enforce canonical page-size arrays at admission

Findings: C3. Priority: P2. State: Ready.

### Outcome

Every positional page-size consumer receives a canonical array where
`pageSizes[index].pageNumber === index + 1`. Injected or direct arrays that are
full-length but shuffled fail before rasterization, placement, or text-layer
mapping.

### Boundary decision

Keep the `IPdfPageSize[]` representation. Do not introduce a versioned Map
contract or convert every internal lookup. The normal page-ops and Poppler
decoders already accept shuffled records, reject duplicates and gaps, and
return canonical order in `scan-cleanup-core/pdfPageSizes.ts:41-159`.

Add one shared `assertCanonicalPdfPageSizes` owner beside the page-size type or
decoder. Call it where an injectable or public core array enters trusted logic.
Do not re-sort an injected array silently. Rejection exposes a broken producer
without hiding it.

Entry points and positional consumers to cover:

- conversion geometry admission at
  `scan-cleanup-core/runScanCleanupConversion.ts:421-458`;
- lossless lookup at `scan-cleanup-core/runLosslessScanCleanup.ts:220-223`;
- conversion lookups at lines 694, 1334, and 1402;
- document-canvas policy at
  `scan-cleanup-core/policy/documentCanvas.ts:678-705`;
- detection retention and progress at
  `scan-cleanup-core/detection.ts:409-418` and line 617;
- source text-layer planning at
  `scan-cleanup-core/sourceTextLayer.ts:219-246`.

Preserve detection's full-document `1..N` invariant. Detection treats a native
manifest index as a source page number. Do not apply final conversion's selected
page mapping to that path.

### Test plan

- Existing page-ops and Poppler decoder tests continue to accept shuffled wire
  records and return canonical order.
- A conversion dependency injects a full-length shuffled array and fails before
  DPI probing, rasterization, or sidecar launch.
- Detection rejects shuffled retained geometry before assigning metadata.
- Lossless and text-layer direct seams reject shuffled geometry.
- A valid partial-page run remains valid because document page numbering is not
  confused with selected-page order.
- Error text names the first unexpected index and received page number without
  dumping document content.

Focused commands:

```sh
pnpm exec vitest run \
  tests/unit/electron/scanCleanupDocumentCanvas.test.ts \
  tests/unit/electron/scanCleanupDetection.test.ts \
  tests/unit/electron/scanCleanupPipeline.test.ts \
  tests/unit/electron/scanCleanupTextLayer.test.ts
pnpm run typecheck
```

### Stop and rollback signals

- Shuffled wire records stop canonicalizing in the two real parsers.
- An injected shuffled array reaches rasterization.
- Valid partial runs fail.
- Page 2 receives page 1 geometry, DPI, placement, or text-layer instructions.
- Guards proliferate inside private consumers rather than protecting admission
  points.

### Package closure record

- [ ] Shared guard and complete caller inventory recorded.
- [ ] Real parser canonicalization stays green.
- [ ] Injected shuffled arrays fail before work starts.
- [ ] Detection, lossless, conversion, canvas, and text-layer cases pass.
- [ ] Targeted and common gates pass.
- [ ] CodeRabbit, Cubic, commit, push, and CI evidence recorded.

## SC-IMP-006, make Rust timing accumulation exhaustive

Findings: C6. Priority: P2. State: Ready.

### Outcome

Document-prior reconciliation adds all 23 `PageStageTimings` fields through one
owner. Adding a Rust timing field without updating accumulation becomes a
compile failure or an explicit test failure.

### Selected design

Implement `AddAssign` or an equivalent `accumulate` method beside
`PageStageTimings::is_empty` in
`native/scan-cleanup/src/protocol/progress.rs:15-70`.

Prefer an exhaustive destructuring pattern with no `..` over a macro or
reflection-like field iteration. A new struct field then makes the accumulator
fail to compile until its treatment is chosen. Replace the manual list at
`native/scan-cleanup/src/adapters/batch_cli.rs:1368-1392` with that owner.

The TypeScript `TScanCleanupStageTotalsMs` at
`electron/features/scan-cleanup/worker/runScanCleanupSidecar.ts:54-68` is an
intentional eight-field presentation subset. Do not make it exhaustive or
silently add the other 15 Rust stages.

No public JSON version or runtime compatibility change is required for this
internal accumulation fix.

### Test plan

- Seed all 23 fields with distinct nonzero values on both operands and assert
  every exact sum.
- Exercise reconciliation through a prior-triggered rerun and prove tier-1
  provenance and classification stay unchanged.
- Keep TypeScript sidecar timing tests unchanged except for a comment or type
  name that makes the subset deliberate.
- Protocol goldens and the exact TypeScript timing schema remain unchanged.

Focused commands:

```sh
cargo test --manifest-path native/Cargo.toml -p evb-scan-cleanup --lib stage_timings -- --nocapture
cargo test --manifest-path native/Cargo.toml -p evb-scan-cleanup --lib reconciliation -- --nocapture
pnpm exec vitest run tests/unit/electron/scanCleanupSidecarStageTimings.test.ts
pnpm run lint:rust
pnpm run typecheck
```

Use the test names that actually exist after implementation. Record filters
that match zero tests as failures, not green evidence.

### Stop and rollback signals

- Protocol fixtures change without a new timing field.
- TypeScript timed-page counts or eight presentation totals change.
- Classification or tier-1 provenance changes.
- A new Rust field can compile without an explicit accumulator decision.
- The change introduces a generated field macro that obscures the serialized
  struct for this small fixed shape.

### Package closure record

- [ ] Exhaustive owner replaces the reconciliation list.
- [ ] All-23-field test passes.
- [ ] Reconciliation behavior and provenance stay pinned.
- [ ] Protocol goldens and TypeScript subset tests stay unchanged.
- [ ] Rust formatting, clippy, targeted tests, and common gates pass.
- [ ] CodeRabbit, Cubic, commit, push, and CI evidence recorded.

## SC-IMP-007, remove presentation progress from the sidecar adapter

Findings: C4. Priority: P3. State: Opportunistic.

Act when the sidecar callback or native progress transport next changes. The
adapter at
`electron/features/scan-cleanup/worker/runScanCleanupSidecar.ts:148-231`
currently maps native events into a second stage and percentage model. Analyze
`page-complete` can become `rendering`, while current product workflows either
ignore or remap the value.

The smallest safe change is to expose decoded native progress plus terminal
timing totals. Detection, raster conversion, and lossless conversion retain
ownership of their user-facing stage, percentage, ETA, and weighted bands.
Migrate every callback and test double in one package. Do not redesign weights
or ETA.

Acceptance checks:

- Analyze `page-complete` is never labeled `rendering` by the adapter.
- Provisional and terminal analysis frames do not regress percentage or report
  false completion in their workflow owner.
- Raster and lossless progress remain on the current weighted model.
- Terminal timing totals still use terminal page timings only.

Focused tests are
`scanCleanupSidecarStageTimings.test.ts`,
`scanCleanupProgressReporter.test.ts`, and `scanCleanupPipeline.test.ts`.
Rollback on changed user-facing percentages, duplicated stages, changed page
release timing, or altered fatal and abort handling.

SC-IMP-007 and SC-IMP-010 both touch the lossless callback at
`runLosslessScanCleanup.ts:169-177`. If SC-IMP-010 lands first, the callback
migration must preserve its submitted-total and page-range guard.

## SC-IMP-008, couple fixed analysis input with its DPI

Findings: N2. Priority: P3. State: Opportunistic.

Act when the native manifest decode seam or canonical analysis-plane assembly
next changes. `manifest_v3.rs:223-361` already validates that
`analysisInputPath` and positive finite `analysisDpi` occur together, but
`batch_cli.rs:1782-1919` carries them separately and later asserts the DPI.

Construct one typed optional analysis input after manifest validation and pass
it into `CanonicalAnalysisPlane`. Remove only the distant `expect` that this
type makes impossible. Preserve the public manifest shape, DPI identity,
classification, and malformed-direct-call error behavior. Do not start a broad
`unwrap` cleanup.

Acceptance checks cover the required-pair manifest cases, malformed direct
input if the new helper is independently callable, fixed-analysis rendering,
mixed classification, and all N6 native safeguards. Roll back if wire
acceptance changes, a malformed input panics, or output DPI and classification
change.

## SC-IMP-009, capture stream classification once per manifest

Findings: N4. Priority: P3. State: Opportunistic.

Act on the next scheduler or worker-sizing change. Native currently probes
manifest input metadata repeatedly. `manifest_has_stream_inputs` is defined at
`batch_cli.rs:991-995` and called at lines 684, 862, and 1203.
`manifest_worker_threads` performs a separate per-page metadata probe at lines
1671-1689.

Compute one per-manifest input-kind value after the producer has created any
FIFO. Thread it through ink preparation, page-job dispatch, and both worker
sizing paths.
Keep the final safe metadata or open check at materialization time. Never cache
classification across runs or mutable filesystem boundaries.

Preserve `scan-cleanup-core/resolveRasterHandoff.ts:163-190`, where FIFO
creation precedes consumer startup. Required tests cover regular and streamed
worker counts, first and windowed stream failure, bounded materialization,
cancellation cleanup, and reconciliation. Roll back on deadlock, premature
open, changed worker policy, leaked producer or consumer, or partial files.

## SC-IMP-010, validate lossless native totals against submitted pages

Findings: T1. Priority: P3. State: Ready, small.

This is defense in depth against a malformed sidecar. The native codec checks a
page number against the envelope's own total, but
`runLosslessScanCleanup.ts:169-177` indexes the submitted page array without
proving those totals agree.

At the first native progress frame, require `totalPages` to equal
`pageNumbers.length`. Reject any page number outside the submitted range before
indexing. Use a clean protocol failure. Never insert `undefined` into the
classified-page set. Do not make the sidecar total authoritative or weaken the
existing codec.

Tests must include a self-consistent native envelope whose total exceeds the
submitted scope, an out-of-range page number, and normal provisional,
terminal, and reconciled progress. Run `scanCleanupPipeline.test.ts` and
`scanCleanupNativeProtocolCodec.test.ts`. Roll back if valid progress maps to a
different source page or terminal cancellation behavior changes.

## SC-IMP-011, remove two local diagnostic smells

Findings: T2 and T3. Priority: P3. State: Opportunistic.

These are separate one-owner edits. Do not open either file only for this work
and do not combine them with a behavioral package merely to hide them.

- In `scan-cleanup-core/createPagePlanResolver.ts:21-61`, remove the constant
  `mismatched=0` token when the resolver is next edited. The function already
  throws on a mismatch. Preserve the hard failure and update the pinned log.
- In `scan-cleanup-core/runLosslessScanCleanup.ts:87-101`, reuse the local
  resolved `dpi` when the planner is next edited. Preserve detected and
  fallback DPI values and canonical analysis pairing.

Run the focused pipeline tests for T2. For T3 also run preview, detection-plan,
and document-canvas tests. Any resolver output, evidence matching, DPI, or
placement change is a rollback signal.

## SC-IMP-012, add ordinary-root liveness only after a long-run trigger

Findings: T4. Priority: P3. State: Trigger gated.

Trigger this package only when measurements show a supported scan-cleanup run
can approach the 24-hour stale threshold, or a startup sweep can overlap a live
ordinary root whose existing child changes without updating the root mtime.
First record the duration and filesystem evidence.

If triggered, add an explicit active marker or registry for ordinary
`mkdtemp` roots. Define owner identity, heartbeat, crash recovery, and cleanup
on success, failure, and cancellation. The startup sweep must skip a proven
live owner and still remove a crashed stale root. Do not touch mtimes as a
substitute for liveness, change the 24-hour policy without evidence, or treat
random suffixes as PIDs.

Tests must hold the root mtime stale while an existing child changes, run a
concurrent sweep, and distinguish live, crashed, symlinked, `EPERM`, PID-owned,
and fresh roots. Preserve raster-budget floors, reserves, and worker settling.

## SC-IMP-013, canonicalize request identity after a caller trigger

Findings: E1. Priority: No action. State: Trigger gated.

Trigger this package when a second payload builder, a direct service caller, or
a reproduced equivalent-request join failure appears. The current production
IPC decoder rebuilds keys in a fixed order, and the renderer builder sorts the
selected pages before `createScanCleanupService.ts:418` serializes the request.

If triggered, build identity from normalized typed fields. Decide explicitly
whether absent and `undefined` optionals are equivalent and whether source-page
order is semantic. Preserve the current ordered one-based page contract unless
evidence says it is a set. Do not add a generic recursive stringifier.

Tests must distinguish equivalent typed requests from genuinely different
options and preserve joins, supersession, single flight, reconnect, and all E4
lifecycle rules. Roll back on false joins, duplicate jobs, or changed page
meaning.

## SC-IMP-014, extract one complete native responsibility

Findings: N1. Priority: P3. State: Trigger gated known debt.

Trigger this only when placement, scheduling, stream transport, publication,
or classification reconciliation already requires substantial work in
`batch_cli.rs`. The file's size is not itself a defect, and the prior audit
already records this debt.

Choose one complete responsibility, move its implementation and tests, and
delete the old owner or unnecessary re-export facade. A helper-only move,
another builder, or another wrapper does not meet this package. Preserve native
API, progress and failure ordering, transaction behavior, FIFO admission,
cancellation, classification, and every N6 test.

The closure record must name the responsibility moved, the former and new
owner, deleted code, dependency direction, and why no parallel state owner
remains.

## SC-IMP-015, make materialized stream names run-unique after concurrency

Findings: N5. Priority: No action. State: Trigger gated.

Trigger this only when a same-process concurrent manifest API appears, two
runs intentionally share a metadata directory, or a collision is reproduced.
The current public CLI uses one manifest per process and Electron uses per-run
scratch roots.

After the trigger, add a per-invocation nonce and exclusive file creation to
the process-ID and page-index name. Keep per-run ownership and cleanup. Tests
must simulate the same PID, directory, and page index under concurrency and
prove no overwrite or cross-run deletion on success, failure, cancellation,
and partial materialization.

## SC-BOUNDARY-001, truncated JBIG2 symbol text regions

Source: [GitHub issue #81](https://github.com/evb0110/evb-viewer/issues/81),
confirmed open on 2026-08-23.
Product priority: P3. State: Open, separate native package.

### Inclusion decision

Retain this issue in the ledger as an explicit scope boundary, but do not create
a `SC-IMP-*` package or merge it into a scan-cleanup finding. The bug is open,
source inspection still shows no synthesized-padding check in
`decode_pdf_symbol_page`, and it has a bounded owner and regression oracle. Its
implementation and closure belong to a separate JBIG2 hardening package.

It does not run on the default scan-cleanup input path. Scan cleanup decodes
generic JBIG2 through `native/scan-cleanup/src/io/raster.rs`. The affected
symbol text-region decoder is public within `jbig2-codec`, is used to verify the
codec's own symbol encoder, and reaches PDF image combine only through the
developer-only `--shared-jbig2-symbols` option. This reachability keeps it at P3
unless a current production or denial-of-service path is demonstrated.

### Current evidence and fix boundary

`native/jbig2-codec/src/symbol.rs:401-520` trusts the text region's declared
instance count and drives the MQ decoder until that count is reached. The MQ
decoder at `native/jbig2-codec/src/arith.rs:209-318` counts synthesized bytes
after its input is exhausted. The generic-region decoder already rejects a
stream that exceeds a small final-flush budget at
`native/jbig2-codec/src/generic.rs:79-108`; the symbol text-region path does not
consult that count.

Existing `symbol_interop.rs` tests added after the issue opened reject every
premature or marker-repaired prefix of one checked-in generated document. Their
shared `assert_symbol_decode_error` helper only asserts `is_err()`. Other sibling
tests do pin error variants. The prefix sweep does not cover the separate case
where an attacker increases `instances` while keeping a valid arithmetic prefix
and termination marker. The full `jbig2-codec` suite passed at the planning
baseline with 39 passed and one external-tool test ignored.

The implementation must:

- share the MQ final-flush budget rule with the generic decoder rather than
  copy a new magic number;
- check exhaustion during text-region decoding, not only after the
  attacker-controlled instance loop finishes;
- return `Jbig2Error::Truncated` or the deliberately selected
  `InvalidArithmeticData` before publishing a bitmap fed by excess padding;
- preserve every well-formed symbol page bit for bit;
- leave generic-region and refinement semantics unchanged except for reusing a
  common decoder exhaustion query or helper.

Do not infer a byte-per-symbol formula without proving it for MQ arithmetic.
Do not cap valid instance counts with an arbitrary product limit. Bound work by
real decoder exhaustion and the existing dimension and pixel limits.
Keep the shared limit and exhaustion query crate-internal. Do not widen the
current private constant or `pub(crate)` decoder method into public API.

### Tests and gates

Add regression cases in `native/jbig2-codec/tests/symbol_interop.rs` or
`decoder_abuse.rs` that:

- encode a valid symbol page, truncate its text-region arithmetic bytes, repair
  the segment length and termination marker, and assert the chosen truncation
  error rather than merely `is_err()`;
- raise the wire `instances` count beyond what the intact arithmetic segment
  encodes and assert bounded rejection;
- sweep truncation points without panic or successful garbage output;
- preserve exact round trips and `jbig2dec` interoperability for well-formed
  symbol pages;
- leave generic source-decoder truncation tests green.

Focused command:

```sh
cargo test --manifest-path native/Cargo.toml -p jbig2-codec --locked
```

Then run `pnpm run lint:rust`, `pnpm run test:rust`, the native export oracle,
resource matrix, strict build, CodeRabbit, Cubic, and CI required by the common
gate matrix.

Stop if an intact encoder output is rejected, symbol or generic pixels change,
external interoperability fails, the loop can consume unbounded synthesized
padding before noticing exhaustion, or the fix changes the default PDF combine
or scan-cleanup generic path.

### Package closure record

This checklist is a specification to copy into the separate JBIG2 package's
closure record. This scan-cleanup ledger records only the boundary decision and
the final independent closure pointer.

- [ ] Issue #81 reproduction and exact old result recorded.
- [ ] Truncated text-region and inflated-instance tests fail on the old code.
- [ ] The decoder rejects excess synthesized padding during the loop.
- [ ] Well-formed symbol, generic, round-trip, and interoperability tests pass.
- [ ] Default scan-cleanup reachability remains unchanged.
- [ ] Targeted and common native gates pass.
- [ ] CodeRabbit, Cubic, commit, push, CI, and GitHub issue disposition recorded.

## No-code decisions

### SC-NOCHANGE-001, N3

Do not implement the proposed invalid-Unicode byte-length bypass fix. JSON
manifest input cannot create a non-UTF-8 Rust `PathBuf` on the production
parser path, and `to_string_lossy()` can overcount replacement characters
rather than undercount them. Preserve strict JSON and manifest bounds. Reopen
only if a non-JSON path constructor becomes reachable.

### SC-NOCHANGE-002, E2

Preserve terminal-state clearing. Active badges describe processing
completion, not whether a generated document remains open. A product request
for persistent output history would need its own state model and UX decision,
not a change to active-job lifecycle.

## Positive invariants

### SC-INVARIANT-001, N6 native safeguards

Every native package must preserve:

- bounded strict manifest decoding in `manifest_v3.rs`;
- normalized and inode-based alias rejection before writes;
- same-directory exclusive staging and complete rollback on error and panic;
- serialized FIFO admission, producer-before-consumer ordering, cancellation,
  and bounded materialization;
- stable progress, failure, and publication ordering.

Passing the success path alone is insufficient. Run the relevant manifest,
hardlink alias, rollback, panic, streamed, first-failure, and windowed-failure
tests for any native package.

### SC-INVARIANT-002, E4 Electron safeguards

Every Electron service or coordinator package must preserve:

- time-bounded and capped generated-output access grants;
- grant removal on renderer destruction, render-process failure, and the
  current main-frame navigation policy;
- active-job cancellation on crash and deliberate detachment on navigation;
- one bounded reconnect listener and deduplicated terminal replay;
- completed-run guard retention until the authoritative output claim finishes;
- cancellation that cannot leave a published or managed output without an
  owner.

Run the applicable scan-cleanup service, coordinator, routing, and document-open
lifecycle tests even when the edited behavior appears unrelated.

## Gate matrix

| Changed area | Required focused and affected gates |
| --- | --- |
| Documentation only | `git diff --check`; no Markdown-specific repository gate exists. |
| `scan-cleanup-core/**` | Named Vitest files, lint, typecheck, unit tests, `pnpm run test:coverage`, `pnpm run validate:iteration`, and `pnpm run build:scan-cleanup`. |
| `packages/contracts/**` | Contract and codec fixtures, generated-artifact drift check, typecheck, unit tests, `pnpm run test:coverage`, strict build, and runtime descriptor regeneration when changed. |
| `native/**` | Named Cargo filters, `pnpm run lint:rust`, `pnpm run test:rust`, resource matrix, strict build, and applicable export or canonical-identity oracle. |
| `electron/**` | Named Electron tests, lint, typecheck, `pnpm run test:coverage`, scan-cleanup and Electron builds, affected validation, and blocking smoke. |
| Placement or generated PDF | Uniformity or matched-canvas evidence, native E2E build, one real-app proof, and visual plus semantic PDF verification. |

For a package that adds, moves, or deletes TypeScript source, also run
`pnpm run fallow` and `pnpm run fallow:dupes`. Update a coverage baseline only
when the new executable source is intentionally covered, and record the reason
in the closure evidence.

For every nontrivial implementation, run normal gates first, then CodeRabbit
CLI against `main` within the repository pass limit. Commit on `main`, run
`node scripts/review-cubic-commits.mjs --commit HEAD`, fix useful findings,
re-review an effective diff change, reconcile with the current remote, push,
and record CI. CodeRabbit and Cubic are fail-open only for the repository's
documented service, authentication, or capacity conditions. Do not approve
paid capacity.

## Per-package closure template

Copy this block into a package's closure record. Do not replace evidence with a
checkbox alone.

```text
Package and finding IDs:
Implementation baseline SHA:
Publication SHA:
Status and date:
Reachable product path:
User-visible failure or hardening rationale:
Evidence class and old-behavior result:
Changed files and behavior owner:
Deleted or migrated owner:
Compatibility constraints and non-goals:
Focused commands and exact results:
Affected repository gates and exact results:
Real-app or artifact proof, path, and SHA-256:
CodeRabbit disposition:
Cubic disposition:
Remote reconciliation result:
CI run and result:
Rollback method:
Remaining risks and newly unblocked package:
```

## Independent review record

Both requested read-only reviews checked the ledger against the current source
baseline. This record captures accepted, rejected, and contradictory advice.
Where the two reviews conflict, Fable 5 High controls unless current source or
test evidence disproves its recommendation.

- Opus 5 High review: ready after edits. Accepted advice added the missing
  coverage and dead-code gates, the explicit `strict_cli_flags` Cargo target,
  corrected Electron and native citations, the direct OCR caller, grant
  lifecycle detail, the localization boundary, the C4 and T1 interaction, and
  more exact issue #81 wording. The proposed E3 test file is now identified as
  new instead of being listed as an existing test.
- Fable 5 High review: ready after edits. Accepted advice covered the same
  missing E3 test distinction, coverage gates, strict CLI target, corrected N4
  citations, and the rule that issue #81's closure checklist belongs in its
  independent JBIG2 package while this ledger keeps only the boundary pointer.
- Reconciliation: both reviewers agreed that issue #81 belongs in the ledger as
  `SC-BOUNDARY-001`, not as a scan-cleanup implementation package. Opus proposed
  allowing the physical part of C1 to start before C2. Fable found the listed
  dependency order coherent. The ledger follows Fable and keeps SC-IMP-004
  dependent on SC-IMP-003 so the first cross-layer parity report already
  includes typed warning codes. No package is marked implemented or closed by
  either review.

## Implementation execution record, 2026-08-23

This section records the implementation run authorized after the audit and
ledger reviews. The planning branch started from `26f45e902`. Before final
review it was rebased without conflicts onto the then-current `origin/main`,
`135d1c6d4`. Before publication it was rebased again without conflicts onto
`a90b46087`. The remote commit had no overlapping paths. The commit IDs below
are the final rebased IDs. No push had occurred when this record was drafted.

### Sequential commit map

| Order | Package | Rebased commit | Result |
| --- | --- | --- | --- |
| 0 | Ledger definition | `72926aeb6` | Added this implementation and closure ledger. |
| 1 | SC-IMP-001, C5 | `52a9934e2` | Confined runnable native manifests to one trusted root while retaining geometry-only and direct CLI compatibility. |
| 2 | SC-IMP-002, E3 | `ff80a424b` | Added a bounded generated-PDF handoff, sender-scoped cancellation, stale-result fencing, and unclaimed working-copy cleanup. |
| 3 | SC-IMP-003, C2 | `7df345c31` | Added typed warning events, native revision 10, legacy artifact handling, shared formatting, and code-based aggregation. |
| 4 | SC-IMP-004 Stage A, C1 | `e83d7853b` | Added the cross-path matched-canvas corpus and normalized physical parity oracle before changing fitters. |
| 5 | SC-IMP-003 follow-up | `d2f74e675` | Closed warning codec, parameter, preview, and aggregation gaps exposed by review and the new oracle. |
| 6 | SC-IMP-002 follow-up | `f7bac5463` | Closed timeout, disposal, late rejection, resource cleanup, and mock-isolation gaps in lifecycle coverage. |
| 7 | SC-IMP-001 follow-up | `214604c36` | Centralized manifest-root construction and diagnostics validation, deleting duplicated source-text parsing. |
| 8 | SC-IMP-004 Stage B, C1 | `90d1991d8` | Aligned raster, lossless, and preview placement policy for measured parity failures. |
| 9 | SC-IMP-005, C3 | `7ab57b8a8` | Enforced canonical page-number order at every positional page-size admission boundary. |
| 10 | SC-IMP-006, C6 | `418d17135` | Made all 23 Rust timing fields use one exhaustive accumulator and kept the TypeScript eight-field presentation subset unchanged. |
| 11 | SC-IMP-010, T1 | `7285e4f53` | Rejected native progress totals and page indices outside the submitted lossless scope. |
| 12 | SC-IMP-007, C4 | `4b5755b02` | Made the sidecar callback carry native progress facts only; workflow owners now construct presentation progress. |
| 13 | SC-IMP-011, T3 | `8e48b8805` | Reused the already resolved per-page lossless DPI without changing detected or fallback values. |
| 14 | SC-IMP-014, N1 | `9d6007cbd` | Moved the complete manifest publication transaction and its rollback test to one private native module. |
| 15 | SC-IMP-003 gate follow-up | `477a1819d` | Updated the last hand-written Rust descriptor assertion from revision 9 to 10 after the full native gate exposed the drift. |
| 16 | Final review corrections | `dc6ddcdf2` | Applied the useful final CodeRabbit findings to path-key exhaustiveness, fixture identity formatting, detail manifests, trusted diagnostics roots, manifest-path auditing, and quantization coverage. |
| 17 | Gate harness correction | `68439e143` | Isolated the stroke-weight oracle child process from a contradictory color environment while preserving the strict empty-stderr assertion. |

### Package closure status

| Package | Status | Closure evidence |
| --- | --- | --- |
| SC-IMP-001 | Implemented | Every product runnable builder and sidecar call shares the same root. Geometry-only construction remains separate. Rootless external manifest, direct input/output, and OCR modes remain supported. Native and TypeScript escape, symlink, FIFO, missing-output, and caller-inventory tests were added. |
| SC-IMP-002 | Implemented | The coordinator owns a deadline and stale-completion token. The renderer uses the existing request-ID batch-open protocol. Main registers cancellable single-PDF requests, and the document service cleans an eventual unclaimed working copy. Timeout, disposal, reinstall replay, sender isolation, cold-open order, and late-result tests were added. |
| SC-IMP-003 | Implemented | Current native, lossless, preview, and conversion owners emit bounded structured events. Raster aggregation no longer parses English. Historical artifacts may omit events only in the artifact decoder. Protocol source, generated Rust, release targets, and the final native descriptor assertion all use revision 10. |
| SC-IMP-004 | Implemented | Stage A recorded out-of-tolerance cases before production changes. Stage B changed the narrow placement owners. The current report covers all 13 requirements and has zero exceedances at a fixed one-pixel tolerance. One lossless case explicitly records a raster-path substitution because that page did not share the document pixel grid. |
| SC-IMP-005 | Implemented | One shared assertion protects detection, lossless, conversion, document-canvas, and source-text entry points. Real parsers still accept shuffled wire records and return canonical arrays. Injected shuffled arrays fail before raster or text work. |
| SC-IMP-006 | Implemented | `PageStageTimings` accumulation exhaustively destructures all 23 fields. Reconciliation uses that owner. The all-field and real rerun tests preserve classification and tier-1 provenance. TypeScript remains an intentional eight-field diagnostic subset. |
| SC-IMP-007 | Implemented after trigger | SC-IMP-010 changed the lossless native callback, satisfying the recorded trigger. The adapter no longer invents stage, percent, ETA, or completed-page presentation. Detection tests pin its synthetic page-analyzed and page-complete output. |
| SC-IMP-008 | Not triggered | No native manifest decode seam or canonical analysis-plane assembly changed. Trusted-root validation after decode did not change the fixed-analysis path and DPI pair. |
| SC-IMP-009 | Not triggered | No scheduler or worker-sizing policy changed. Stream classification and its repeated probes remain known opportunistic debt. |
| SC-IMP-010 | Implemented | Tests cover a self-consistent envelope whose total exceeds submitted scope, an out-of-range page index, and valid provisional, terminal, and reconciled progress. |
| SC-IMP-011 T2 | Not triggered | `createPagePlanResolver.ts` was not edited. The constant diagnostic token remains opportunistic and was not opened only for cleanup. |
| SC-IMP-011 T3 | Implemented after trigger | SC-IMP-010 and SC-IMP-007 edited the lossless planner. The local resolved DPI is now reused. A mutation-checked scratch-footprint test fails for both wrong fallback substitutions. |
| SC-IMP-012 | Not triggered | No supported run approached the 24-hour threshold, and no live ordinary-root sweep collision was reproduced. No liveness registry or mtime workaround was added. |
| SC-IMP-013 | Not triggered | No second production request builder, direct service caller, or equivalent-request join failure appeared. Document opening changes did not change scan-cleanup request identity. |
| SC-IMP-014 | Implemented after trigger | `90d1991d8` made substantial native placement-policy changes and `418d17135` reopened classification reconciliation. `ManifestPublicationTransaction`, its lifecycle, `run_manifest_transaction`, and the direct rollback and panic test moved from `batch_cli.rs` to private `adapters/manifest_publication.rs`. The former implementation and test were deleted. |
| SC-IMP-015 | Not triggered | No same-process concurrent manifest API, shared metadata directory, or collision appeared. Per-run Electron scratch ownership remains unchanged. |

SC-IMP-014 has one-way dependency direction. `batch_cli` supplies a validated
manifest and an operation. `manifest_publication` owns staging, commit,
rollback, panic recovery, and rollback-error ordering. It depends on the
per-file `StagedFileBackup` IO primitive but has no dependency back to
`batch_cli`. The private module has one `pub(super)` entry point for its sibling
caller. No state owner, facade, or re-export remains in the former module.

### Retained parity evidence

The ignored local evidence root is
`.devkit/test/scan-cleanup-uniformity/parity-corpus/`.

- `parity-corpus-report.json`: 654,365 bytes, SHA-256
  `fbd0592b3e32830bebf6e1a1105f33e244501be99305a600ef22ab1248e84c63`.
- `parity-corpus-identities.json`: SHA-256
  `ff86ab69265e1bd8815cf4cd51609f592db6b870f4087c0e6887e417a1bb9e08`.
- Tolerance: `0.16933333333333334` mm, exactly one raster canvas pixel at
  150 DPI.
- Coverage: seven fixture PDFs, ten cases, 22 cross-path comparisons, all 13
  required scenario labels covered, no coverage gaps, and zero exceedances.
- Recorded substitution: `paper-larger-than-canvas` page 2 uses the raster path
  instead of lossless final because it does not share the document pixel grid.
- Typed warning channel limitations: none.
- Engine SHA-256 values: `evb-scan-cleanup`
  `ce757dc593494034c47bf3e5e43674a86414703639b3405430cc279eb6936553`,
  `evb-pdf-page-ops`
  `6af78156c822fac861c8f197789afd7358f1e66f5c4b68e92f856a1f8f254d39`,
  and `evb-pdf-image-combine`
  `3771bc20b3f92f0352f69c00617b9a8c1e8df37e1558f9eb60971746198fb141`.

### Verification retained during implementation

- SC-IMP-007: 223 focused Electron tests and six CLI adapter tests passed.
  Electron, test, and script typechecks, changed-file lint, and
  `git diff --check` passed. The accumulated `pnpm validate:iteration` run at
  that point covered 291 files and 3,364 tests.
- SC-IMP-010: 92 focused pipeline and native-codec tests passed. Lint,
  typecheck, and mutation checks passed.
- SC-IMP-011 T3: four focused files, 257 tests passed. Typecheck, lint, and
  `git diff --check` passed. Replacing the resolved value with the document DPI
  changed the oracle from 23 MiB to 37 MiB. Dropping the document fallback
  changed it to 77 MiB. Both mutations failed.
- SC-IMP-014: the moved rollback and panic test passed. Eight alias, stream,
  bounded-materialization, and publication tests passed. The FIFO admission
  ordering test passed. The full crate library result was 569 passed, three
  ignored, and zero failed. Seven `page_cli` rollback, publication, typed
  progress, reconciliation, and deterministic-order tests passed. Rust format,
  workspace clippy with warnings denied, and `git diff --check` passed.
- The final `pnpm run test:rust` before this record completed successfully for
  the locked Rust workspace and ended with native search parity verified for
  ten cases. Its first run correctly failed on the stale revision-9 assertion;
  `477a1819d` fixed that one owner and the rerun exited zero.

Earlier package-focused command output was streamed during implementation but
not retained as a package-specific artifact. The final accumulated gates below
are the authoritative current-tree evidence. This record does not invent
per-package counts that were not preserved.

### Review dispositions

- Opus 5 High implemented the code stages. Luna Max performed mechanical,
  read-only inventories. Fable 5 High reviewed the ledger before execution;
  later use was stopped for budget reasons.
- Native Sol at xhigh independently reviewed SC-IMP-007 and found no issue. It
  later adjudicated the remaining triggers and found only SC-IMP-014 met. Its
  post-implementation SC-IMP-014 review found no issue and confirmed the move
  was behavior-identical except for private sibling visibility.
- Cubic reviewed every stage commit. Useful findings were fixed in the named
  follow-up commits or by amending the same stage. For SC-IMP-007, advice to
  restore presentation state to the transport was declined because it would
  recreate the owner duplication the package removes. For SC-IMP-011 T3, the
  suggestion to weaken the exact 23 MiB assertion was declined because both
  wrong DPI substitutions would then pass. SC-IMP-014 and the protocol-parity
  follow-up passed Cubic without findings.
- Two broad CodeRabbit passes were used during implementation. The reserved
  final accumulated pass ran on the complete diff against `origin/main` after
  `coderabbit doctor` passed all nine checks. Nine findings were assessed.
  Useful findings were implemented in `dc6ddcdf2`: native output path keys are
  derived and asserted exhaustively, fixture identity hashes retain zero
  padding, detail manifest paths must be nonempty, the diagnostics trusted root
  is resolved once, unchecked manifest-path fields are audited by exact field
  trail, the TypeScript check documents the native revalidation boundary, and
  negative quantization cases are pinned. The diagnostics-script source grep
  remains an intentional wiring tripwire, and a parameter-only rename was
  declined as style-only. No further broad CodeRabbit pass was run because the
  repository pass limit had been reached.
- Native Sol at xhigh reviewed the complete final-correction diff and found no
  security, correctness, specification, or repository-standard issue. Focused
  verification covered 284 TypeScript tests and one Rust test. Typecheck, lint,
  Rust format, clippy, the full 1,009-file and 8,184-test unit run, and the
  affected native checks passed.
- Cubic passed `dc6ddcdf2` with one declined advisory. The output path-key list
  is compile-time exhaustive over `INativeScanCleanupOutputV3`; a new typed key
  fails the assertion, while descriptor-value changes have separate tests.
  Cubic returned an invalid final response for `68439e143` and failed open under
  the repository service-error rule. The tracked correction had a deterministic
  red reproduction before the change and green focused runs afterward.

### No-code, invariant, and boundary disposition

- SC-NOCHANGE-001 remains closed with no code. The production path still uses
  bounded JSON deserialization into strict UTF-8 Rust strings and paths. No
  non-JSON path constructor appeared. The proposed invalid-Unicode undercount
  is unreachable on this path.
- SC-NOCHANGE-002 remains closed with no code. Processed-page state continues
  to clear at terminal state. Generated output history remains a separate
  product and state-model question.
- SC-INVARIANT-001 remained green through strict manifest, trusted-root,
  hardlink alias, rollback, panic, streamed, first-failure, windowed-failure,
  reconciliation, Rust lint, and full Rust workspace gates.
- SC-INVARIANT-002 remained green through coordinator, service, routing,
  document-open, timeout, disposal replay, late-open suppression, working-copy
  cleanup, capability, crash, navigation, and run-guard tests.
- SC-BOUNDARY-001 remains separate. GitHub issue #81 was still open on
  2026-08-23 as `jbig2: symbol-page text region does not detect truncated
  arithmetic streams`. Default scan cleanup uses generic JBIG2 decoding, not
  the affected symbol-page decoder. The issue retains its P3 hardening package,
  exact test plan, and independent closure checklist. This implementation does
  not close or change the issue.

### Final publication gates

Before this final evidence edit, the tracked worktree was clean, the sequential
commits had been rebased without conflict onto `a90b46087`, and `origin/main`
was an ancestor of local `main`.

- Final CodeRabbit: local CLI on the Mac, base `origin/main`, complete
  accumulated scope. `coderabbit doctor` passed nine of nine checks. The review
  completed with nine findings, seven useful correction groups implemented in
  `dc6ddcdf2`, and two findings declined with the reasons recorded above.
- Final all-gates run: all four selected gates exited zero. The machine-readable
  summary is
  `.devkit/gates/2026-08-23T110306Z/summary.json`. `validate` ran from
  11:03:06Z to 11:20:46Z, `test:coverage` to 11:22:02Z,
  `release:verify` to 11:43:59Z, and release-cut preflight to 11:44:02Z.
- `validate` passed 1,008 unit files and 8,127 tests, the locked Rust workspace,
  native search parity for ten cases, the resource matrix, strict build, and
  the blocking Electron smoke suite. The scan-cleanup crate result was 569
  passed, three ignored, and zero failed.
- Coverage passed 1,008 files and 8,127 tests at 64.81 percent statements,
  59.49 percent branches, 64.63 percent functions, and 65.28 percent lines.
  The coverage ratchet and zero-execution tripwire for 166 production files
  passed.
- Release verification reran the locked Rust workspace and ten-case native
  search parity. The release-mode canonical-identity corpus test passed in
  203.84 seconds. Resource, architecture, static-report, type-coverage, strict
  build, and signed local macOS package checks passed. Packaged native tools and
  `app.asar` passed their smoke and content checks.
- The package verifier recorded one existing named gap. An ad-hoc signed macOS
  app cannot run the packaged sidecar fold-clip smoke in place under the local
  provenance policy. It also skipped packaged startup and notarization because
  the local notarization credentials were absent. These are declared local
  package limitations, not suppressed failures.
- Release-cut preflight passed for `0.1.427` to `0.1.428` on `origin/main`.
- A separate final `pnpm run validate:iteration` exited zero with 292 files and
  3,372 tests. Its evidence is
  `.devkit/analysis/gates/2026-08-23T11-45-01-128Z-3691-a6e7d61e.ndjson`.
- Cubic for this evidence commit, the last remote fetch, fast-forward proof,
  publication tip, direct push result, and GitHub Actions result must be
  reported in the task handoff. A commit cannot contain its own final SHA or
  the CI run created by its push.
