# PDF annotations audit implementation ledger

Date: 2026-08-23

Source audit: `docs/internal/pdf-annotations-feature-audit-2026-08-22.md`.

## CURRENT checkpoint, refreshed 2026-09-07 07:33 UTC

- The authoritative integration worktree is
  `/home/ubuntu/.t3/worktrees/evb-viewer/t3code-own-sync`, branch
  `own-annotations`, clean at publication head
  `150a7e4d8ac19e3d0c55bcbe2e0380fc3dcf1421`. Source acceptance covers its
  parent `8b8daf216328931576328fd47ed7f8745e27b6ff`; the publication commit is
  ledger-only. The separate candidate is historical at
  `bea27ef44334a2207e994876a272c49b06955671`
  on `ticket/196-renderer-interface`; its evidence is not integrated-main
  evidence. `origin/main` is `b4b6b44135dce544489989caebc9250ab8078359` and
  must be rechecked only at the publication boundary. The coordinator owns
  shared helpers, launchers, configuration, interop scripts, generated WASM,
  the pinned PDF.js artifact and verifier, this ledger, integration,
  publication, and GitHub state. Jason completed the bounded read-only closure
  audit. The delayed-toolbar worktree and unrelated default Electron session
  remain outside this worktree.
- No local gate, Electron session, or writer is active in this worktree. Hosted
  PR #206 run `34094454954` is terminal `failure`. Its dedicated native/build,
  Electron, packaged, and browser jobs passed, but Quality Gates failed because
  the coverage job had no `qpdf` and its positive admission unit case assumed a
  native binary that that job does not build. The focused correction installs
  qpdf in the quality job and gives the unit case a disposable executable via
  `EVB_PDF_PAGE_OPS_PATH`; no product behavior or accepted Electron gate is
  waived. The follow-up hosted run `34096135979` then failed at the same
  interop test because `pdftoppm` was also absent from that job; every other
  required hosted job passed. The quality job now provisions
  `imagemagick`, `poppler-utils`, and `qpdf` as one asserted set. A new hosted
  run is required. The latest integrated gates tested SHA
  `8b8daf216`: canonical validation exited 0 under
  `.devkit/gates/2026-09-07T060244Z` with summary
  `.devkit/gates/2026-09-07T060244Z/summary.json`; #350 passed `4/4` in
  `.devkit/analysis/gates/2026-09-07T06-17-51-869Z-2538315-131f0968.ndjson`;
  #167 passed `2/2` in
  `.devkit/analysis/gates/2026-09-07T06-19-57-355Z-2540800-b720c9a6.ndjson`;
  annotation lifecycle passed `7` with `9` documented skips in
  `.devkit/analysis/gates/2026-09-07T06-21-23-637Z-2542690-787601a5.ndjson`;
  save pipeline passed `5` exercised tests with one intentional skip in
  `.devkit/analysis/gates/2026-09-07T06-23-40-048Z-2548118-8d19a269.ndjson`;
  native save/reopen passed `4/4` in
  `.devkit/analysis/gates/2026-09-07T06-27-32-071Z-2554797-c0b3eca8.ndjson`;
  and integrated Viewer Smoke passed `25/25` in
  `.devkit/analysis/gates/2026-09-07T06-31-43-696Z-2566963-838c5c8a.ndjson`.
- Required exact and feature acceptance is green on the same SHA. Exact 882
  annotation save passed `8/8` at
  `.devkit/analysis/gates/2026-09-07T06-41-25-713Z-2583413-038c63de.ndjson`;
  exact 882 native matrix passed `2/2` at
  `.devkit/analysis/gates/2026-09-07T06-50-14-101Z-2594967-66f64c17.ndjson`;
  exact 882 native preview passed `3/3` at
  `.devkit/analysis/gates/2026-09-07T06-54-34-776Z-2600616-950e9192.ndjson`;
  exact 2,646-page acceptance passed `2/2` at
  `.devkit/analysis/gates/2026-09-07T06-56-26-033Z-2603529-7eed8c47.ndjson`;
  split-pane lifecycle passed `1/1` at
  `.devkit/analysis/gates/2026-09-07T07-00-19-572Z-2608508-4c3a40f7.ndjson`;
  and draw-shapes passed `16/16` at
  `.devkit/analysis/gates/2026-09-07T07-01-42-639Z-2611039-93a485fa.ndjson`.
  The first split-pane attempt at
  `.devkit/analysis/gates/2026-09-07T06-59-45-326Z-2607361-a82c9029.ndjson`
  selected `e2e-regression`, which does not include that file. It is a routing
  failure, superseded by the correctly selected green run, not product evidence.
- The exact source fixtures remain hash-verified and untouched: the 882-page
  file is `722178517` bytes with SHA-256
  `1660bced91f628b9acbb2fc0f9dac29fe783a3f43d26231d8f3b0c73133b21b6`, and the
  2,646-page file is `2168527413` bytes with SHA-256
  `5609c151c1cec881da4b97ec7028250574f8f0ee67540dcdc8808cc7b8ab0aea`.
- The mixed-size broad red at
  `.devkit/analysis/gates/2026-09-06T09-13-35-511Z-3977170-a1fd46a8.ndjson`
  remains historical. It omitted `EVB_PDF_PAGE_OPS_ENABLE=1` and predated the
  fit-width repair. The configured broad gate passed `24/24`, and the current
  integrated Viewer Smoke passed `25/25`, including mixed-size fitting,
  crop-overlay, PNG, DjVu, and split continuity cases. The old red remains in
  the ledger and is not waived. Earlier candidate and pre-migration greens are
  invalid for claims about this merged tree.
- Remaining work is closure and publication, not a new implementation
  hypothesis: publish the focused correction through PR #206, obtain a passing
  current-head hosted run, merge and verify exact integrated `main`, run the
  required final CodeRabbit attempt with its documented fail-open handling,
  update the #167 reproducible report with the integrated Linux evidence, and
  then close #196, #168, #167, #350, #166, and Project 4 in dependency order
  after their actual states are verified. #168's
  6.3.311 migration is present and locally accepted, but its issue stays open
  until publication, hosted checks, integrated-main verification, and its fork
  disposition are recorded. The owner visual check remains outside closure.

### 2026-09-07, hosted run `34094454954` terminal failure and correction

The hosted run completed with all dedicated native/build, Electron, packaged,
browser, Rust, and scan-cleanup jobs green. `Quality Gates` failed only in its
coverage process. `tests/unit/scripts/interopCorpus.test.ts` could not spawn
`qpdf` because the quality job did not install it. The positive case in
`tests/unit/scripts/assertElectronNativePageOps.test.ts` looked for a built
`evb-pdf-page-ops`, but that job does not build native tools. The production
Electron jobs still build and admit the real binary. The correction installs
qpdf in the quality job and gives the unit test an explicit disposable
executable through `EVB_PDF_PAGE_OPS_PATH`, retaining the `--version` and
executable checks. Focused local coverage is green at 11/11. The hosted run
  must be repeated on the corrected head before PR #206 can merge.

### 2026-09-07, hosted run `34096135979` terminal failure

The corrected admission test and qpdf validation passed in hosted coverage.
The same interop execution then failed when the independent renderer attempted
to spawn `pdftoppm`; the quality job had installed qpdf but not
`poppler-utils`. Every dedicated native/build, Electron, browser, packaged,
Rust, and cleanup job passed. The workflow correction adds `poppler-utils` to
the quality-job PDF tool install. This remains a runner provisioning fix, not a
change to rendering assertions or a waiver of the Linux rendering requirement.

### 2026-09-07, hosted run `34097520081` terminal failure

The complete external executable set was audited after the third exact-head
failure. The quality job had qpdf and Poppler, but the independent renderer
then failed on `identify` from ImageMagick. The run's dedicated native/build,
Electron, browser, packaged, Rust, and cleanup jobs passed. The workflow now
installs `imagemagick`, `poppler-utils`, and `qpdf` together, and the focused
CI topology test asserts that exact package set. This is a provisioning fix;
the Linux rendering and negative-control assertions remain unchanged.

### 2026-09-07, integrated acceptance at `8b8daf216`

The integrated branch passed the full required local acceptance queue after
the single canonical validation run. The native capability admission came from
the published headless launcher, and all Electron work used the named-session
lifecycle. The #350 gate used the private 3,153-byte legacy fixture and the
private reported-notes fixture. The #167 gate used the tracked five-kind
corpus, qpdf, independent Linux rendering, real EVB Electron import/edit/save/
reopen coverage, and the supported encrypted-input save flow. Its retained
render artifacts are under
`.devkit/artifacts/issue-167-interop-integrated-8b8daf216`.

The first custom #350 command failed before CDP because its direct launcher
left Electron's `chrome-sandbox` at mode 0755 instead of using the canonical
wrapper's no-sandbox environment. Its session log is
`.devkit/sessions/e2e-run-mtqukxys-c324ae-legacy-note-350-1788761804843/session.log`.
The canonical rerun passed all four cases, so no product or system permission
change was made. No Acrobat, Preview, macOS, owner-created fixture, or human
sign-off was used or is required for #167.

## Historical checkpoint, refreshed 2026-09-07 05:01 UTC

- The candidate tree is based at `72f411b388026348b4f1619f649d3fecd2b1e2c2`
  on `ticket/196-renderer-interface`, with intentional uncommitted coordinator
  changes for the pinned PDF.js 6.3.311 migration, the renderer-owned link
  overlay, projected-scroll queue, diagnostics, and their tests. `origin/main`
  is `b4b6b44135dce544489989caebc9250ab8078359`. The tree has not been
  committed or published after the migration work.
- No gate or Electron session is active in this worktree. The repaired
  canonical validate run tested this SHA plus the frozen migration tree at
  `.devkit/gates/2026-09-07T034313Z`, coordinator session `49820`, and
  finished at `03:55:42 UTC` with exit 0. Its consolidated evidence is
  `.devkit/analysis/gates/2026-09-07T03-43-14-494Z-2218244-210e0443.ndjson`.
  It passed 1,304 test files with one skipped file, 11,050 tests with eight
  skipped tests, coverage and type-coverage floors, the zero-execution
  tripwire, strict build, native matrix, bundle integrity, and blocking smoke.
  The prior `02:57:04`, `03:10:18`, and `03:38:04` failures remain historical.
  The unrelated Electron session at
  `/home/ubuntu/projects/evb-viewer/.devkit/sessions/default` remains outside
  this worktree and must not be stopped or cleaned.
- The two reds from that gate are now repaired with focused checks. Full ESLint
  is green after converting the PDF.js lifecycle shape to the repository's
  interface convention and formatting the renderer fixtures. The static bundle
  integrity selector passes 58/58 after shrinking its expected allowance set to
  the one runtime idiom PDF.js 6 actually emits. The repository-native
  tests-as-never check passes 380 assertions in 94 files, typecheck passes,
  Fallow duplication passes, and `git diff --check` passes. These checks do not
  replace the required canonical validation gate.
- Coordinator owns shared helpers, launchers, configuration, interop scripts,
  generated WASM, the PDF.js artifact and verifier, this ledger, integration,
  publication, and GitHub state. Native child lanes are terminal. The delayed-
  toolbar worktree remains separate and untouched.
- The pinned #168 artifact is now present at
  `vendor/pdfjs-dist/pdfjs-dist-6.3.311-6922bee2.tgz`, SHA-256
  `f1db91efda7463d099e238acc296a78e2dc66889660190136ba5c44a8536f00a`, with
  source commit `6922bee2b3dd047c954d5717a533a2d701559c17`, source tree
  `0fc8b8db395e8ab30ddec61a78bb9ad72d82512b`, and reproducible two-pack
  evidence. `node scripts/verify-pdfjs-provenance.mjs` passes, including the
  normalized public Liberation license copy. The app dependency, lockfile,
  copied assets, CSS seam, runtime compatibility adapter, and version-coupled
  tests are migrated but still uncommitted.
- Current focused evidence on this migrated tree is typecheck green, app
  migration selectors `182 passed, 4 skipped`, Electron migration selectors
  `16/16`, script selectors `49/49`, compatibility adapter `3/3`,
  `git diff --check`, Electron install verification, and provenance
  verification. The post-migration canonical validation now passes. The
  post-migration #350 legacy-note gate passes `4/4` with the verified private
  fixtures. The post-migration #167 gate passes `2/2`, the annotation
  lifecycle slice passes `7` tests with its documented `9` skips, and the full
  Viewer Smoke file passes `25/25` across PDF and DjVu. The save pipeline passes
  five exercised tests with one intentional skip, native save/reopen passes
  `4/4`, exact 882 annotation save passes `8/8`, the exact 882 native matrix
  passes `2/2`, exact 882 native preview passes `3/3`, the native split-pane
  lifecycle passes `1/1`, draw-shapes passes `17/17`, and exact 2646 passes
  `2/2`.
- The historical mixed-size broad red remains visible as a failed artifact, but
  the post-migration Viewer Smoke run passed its mixed-size fitting case and
  provides current topology evidence. It is no longer an unresolved candidate
  failure. Earlier pre-migration greens remain historical and do not prove the
  migrated tree.
- Halley, Pasteur, and Pauli completed their read-only reviews with no source
  edits. The coordinator retains all shared and production file ownership. No
  heavy run is active. The next queue is final review and tree reconciliation.
  After that, commit and reconcile
  #196/#206/#349 with current main, complete #168's pinned migration and
  integrated verification, run final review and validation, and close the
  project only after integrated evidence matches the final tree.

## Historical checkpoint, refreshed 2026-09-06 18:21 UTC

- Candidate commit: `d66433d2801df25b33769e616a41292cc51e3` on
  `ticket/196-renderer-interface`, with uncommitted helper, corpus, renderer,
  native-test, CSS-policy, fit-width, topology-test, interop-unit-test,
  documentation, ledger, and generated-WASM changes owned by the coordinator.
  The interop unit test has the typed `inputPaths: []` call-site fix, and the
  native-page-ops admission helper has its typed `project` option declaration.
- Integration reference: `origin/main` at `4b0b13a013ae309b30a76a9c734f672215a6fc7b`; no candidate commit has
  been integrated or verified on main yet.
- Live heavy run: none. The required validation rerun passed from
  `.devkit/gates/2026-09-06T173538Z/01-validate.log`, with summary
  `.devkit/gates/2026-09-06T173538Z/summary.json` and consolidated evidence
  `.devkit/analysis/gates/2026-09-06T17-35-38-877Z-724069-30da07f7.ndjson`.
  It ran 1,276 test files with 10,806 passing tests, 8 skipped tests, and one
  skipped file. Lint, typecheck, coverage ratchet, zero-execution coverage,
  native tests and resource matrix, strict build, bundle integrity, and
  blocking Electron smoke all passed. The blocking smoke reported 2 passed
  and 1 skipped test. The previous validation failure at
  `.devkit/gates/2026-09-06T143553Z/01-validate.log` remains historical; its
  `inputPaths` type error and the later native-admission `project` inference
  error are both fixed and covered by focused checks. The separate
  delayed-toolbar worker remains outside this worktree and is not being
  touched. Recent Electron runs used the published named-session lifecycle.
  One PNG sub-session needed the documented process-tree fallback after its
  graceful controller deadline; it left no candidate Electron survivor. The
  follow-up focused Squiggly run passed
  1/1 with `EVB_PDF_PAGE_OPS_ENABLE=1` at
  `.devkit/analysis/gates/2026-09-06T15-58-43-259Z-563648-d13d2518.ndjson`.
  The required-fixture #350 run passed 4/4 with native page operations enabled
  at `.devkit/analysis/gates/2026-09-06T16-00-37-075Z-566273-466ae0b5.ndjson`.
  The 14:56 broad regression was launched without that required environment
  flag. Its annotation, markup, and related native-save failures remain a
  failed historical artifact but are invalid for product diagnosis. They must
  be replaced by correctly configured evidence, not waived.
- The coordinator added a native-page-ops admission seam to the canonical
  headless launcher. Native-required projects now export
  `EVB_PDF_PAGE_OPS_ENABLE=1` and run
  `scripts/assert-electron-native-page-ops.mjs` before the Electron command.
  The check verifies an executable `evb-pdf-page-ops` with `--version`; an
  explicit `EVB_PDF_PAGE_OPS_DISABLE=1` remains admissible for intentional
  negative tests. The focused admission unit lane passed 4/4, and a launcher
  `--help` probe reached Vitest only after the admission message. The new
  launcher script and its unit test are coordinator-owned files in the pending
  candidate commit.
- Historical broad failure, now dispositioned by a correctly configured pass:
  the mixed-size viewer smoke remains marked failed in broad artifact
  `2026-09-06T09-13-35-511Z-3977170-a1fd46a8` at
  `viewerSmoke.e2e.test.ts:2730`, with a concrete cause now identified. During
  a pending page-2 navigation, `ResizeObserver.handleResize` recomputed fit
  width for current page 1 after navigation had computed page 2. The repair
  passes the trusted resize anchor page into the scale calculation and carries
  the same semantic page through the deferred workspace fit call. The focused
  repair run passed at
  `2026-09-06T15-46-12-173Z-544080-0776c576`; the ten-predecessor topology
  passed 10/10 at `2026-09-06T15-48-50-806Z-546810-1e84ec9c`. The correctly
  configured broad run passed 24/24, including the mixed-size fit and
  crop-overlay cases, at
  `2026-09-06T18-02-34-043Z-784584-3bda45c5.ndjson`. The old red is retained
  as historical evidence and is not waived.
- Active ownership and next queue: Planck, Kuhn, Gauss, Tesla, Locke, Anscombe,
  Pascal, and the short-lived Avicenna review lane completed or were closed
  without source changes. The coordinator owns the shared launcher, helpers,
  configuration, all three interop scripts, generated WASM, this ledger,
  report, publication, and central heavy-test scheduling. Tesla verified that
  `tests/unit/scripts/interopCorpus.test.ts`
  executes both new MJS scripts and recorded 72/101 and 79/113 covered lines;
  no further coverage test is justified. Locke produced the read-only #168
  plan in ignored `.devkit/issue-168-prep/README.md`, including the verified
  5.7.304 provenance and the unverified 6.x target handoff. Anscombe produced
  the mixed-size diagnostic proposal without editing or launching Electron.
  The split anchor hypothesis has a focused red/green disposition below. The
  validation gate, #350, exact 882/2646, and correctly configured broad
  Viewer Smoke acceptance are green. CodeRabbit was attempted once and
  failed before returning findings because its service closed the WebSocket;
  `coderabbit doctor` passed 9/9, so the documented fail-open path is recorded
  below. The next gates are candidate commit and reconciliation with current
  `main`, #196/#206 integration, the gated #168 6.x build and receipt,
  integrated-main acceptance, and accurate issue/project closure. Historical
  red artifacts remain below for traceability and are not treated as current
  failures.
- Pascal's #168 receipt search found no 6.x distribution or tarball. The only
  present archive is the verified 5.7.304 package, SHA-256
  `4d6fa1de10a0245230ccd986e7679d03ebb4249e57901b228db84726214f5adf`, with
  the matching `f029c046` provenance. The pinned 6.x source is commit
  `6922bee2b3dd047c954d5717a533a2d701559c17`, tree
  `0fc8b8db395e8ab30ddec61a78bb9ad72d82512b`, targeting 6.3.311, but has no
  generated package receipt. #168 therefore remains preparation-only. Its one
  later gated action is a clean full-history fork build, receipt, hash and
  verifier run after #196 integration.
- Final candidate evidence after the latest source changes is recorded below:
  #350 at `2026-09-06T17-47-42-656Z-764581-4f680ff6`, exact 882 at
  `2026-09-06T17-50-28-015Z-768152-47f266e1`, exact 2646 at
  `2026-09-06T17-59-21-375Z-780331-bc823f92`, and broad Viewer Smoke at
  `2026-09-06T18-02-34-043Z-784584-3bda45c5`. Corpus reproducibility and qpdf
  checks passed, and the fresh #167 real-Electron gate passed 2/2 at
  `2026-09-06T18-18-14-963Z-812978-fc5a8a7c`, with retained independent
  renderer evidence in
  `.devkit/artifacts/issue-167-interop-negative-control-final`.

## Verification baseline

- Audit baseline: `26c7b8d6b641f81c501d66dcf239a3ff90d31bcd`. During
  verification `main` advanced to `8438d6686` (navigation ledger, CI runbook
  commit); a path-scoped diff over `app/modules/pdf-viewer` and
  `app/modules/workspace-shell` between the two is empty, so citations hold at
  both revisions.
- Method: six independent read-only verification passes (undo-redo,
  highlight/FreeText, sidebar and H1 trace, store/sync/persistence,
  shapes/serialization, and the audit's open interleaving and orphan-editor
  questions), each instructed to refute claims first and to trace reachability
  through production callers and existing tests. A synthesis pass by the
  session owner set the dispositions below. No files were modified and no
  tests were run during verification.
- Two verification transcripts abbreviated directory names in citations; this
  ledger uses canonical repo paths throughout (for example
  `annotations/bridge/pdfjs-runtime/useAnnotationSync.ts`, not
  `composables/annotations/...`). Paths are relative to
  `app/modules/pdf-viewer/` unless a longer prefix is shown.

## Status and priority vocabulary

| Term | Meaning |
| --- | --- |
| Confirmed | The cited condition exists in a reachable production path. |
| Partial | Part of the claim is true, but scope, mechanism, or impact is overstated. |
| Refuted | The current code prevents or contradicts the reported behavior. |
| P1 | A bounded corrective patch should be scheduled. |
| P2 | Add hardening or parity coverage before changing the area. |
| P3 | Cleanup only. Fold it into nearby work in the same area. |
| No action | Preserve the current behavior or evidence. |

No item is a verified P0. Seven items are P1: H2, M9, H1 (focus half), M6,
L8, M1, and Q1 (the print save-lease bypass, upgraded from the audit's
unverified risk list). The audit's two "High" headliners survive, but one of them (H1) at
half its claimed scope, and two of its Med-High items (M2, M3) fall to Low
because the mechanisms it feared are already guarded.

## Corrections to the audit

The audit's architecture description and most citations verified as written.
The following claims did not survive verification and should not be relied on.

Refuted:

1. **M5, empty selection boxes.** The local guard would accept `[]`
   (`annotations/bridge/pdfjs-runtime/useAnnotationHighlight.ts:324-365`), but
   the pinned pdf.js 5.7.284 never produces one: `getSelectionBoxes` returns
   `null` for collapsed, zero-area, or out-of-layer selections
   (`node_modules/pdfjs-dist/build/pdf.mjs:4189-4254`), and the cached-selection
   path rejects collapsed or out-of-text-layer ranges before restoration
   (`useAnnotationTextSelectionCache.ts:47-98`). No orphan entity is mintable
   through production input.
2. **M11, cross-page selections truncated to the start page.** They are
   rejected whole, not halved: pdf.js refuses a range whose common ancestor is
   outside the start text layer and returns `null`
   (`pdf.mjs:4194-4199,4251-4254`). What remains is only a silent no-op with
   debug-level logging (`useAnnotationHighlight.ts:617-629`).
3. **H1's delete half.** Sidebar shape deletion works. It routes through
   `createPageAnnotationDeleteActions.ts:131-142` into the mutation service,
   which resolves the shape canonically and tombstones it before the broken
   inner shape action's `false` return is ignored
   (`runtime/annotations/useAnnotationMutationService.ts:123-138`). Only shape
   focus is dead. There is also no arbitrary-shape hazard: production id
   misses resolve to `null`, not `undefined`
   (`annotations/domain/externalIdentityIndex.ts:71-82`).
4. **M3's mechanism.** `reconcileEditorPresence` does not require a prior
   external binding; it tombstones any missing, unsaved, non-deleted entity
   (`annotations/domain/annotationStore.ts:554-578`, especially `:567-576`)
   and runs after history replays
   (`runtime/sessions/createPdfAnnotationSession.ts:705-725`). Failed-binding
   orphans are transient, not permanent.
5. **M2's severity.** Normal page operations are shielded: structural ops go
   through a document reload that registers a `source: 'file'` ledger command
   (`app/modules/workspace-shell/composables/document-session/createDocumentHistory.ts:583-592`),
   and the new-document watcher clears annotation history on proxy swap
   (`runtime/sessions/createPdfAnnotationSession.ts:320-332`). The stale-undo
   window exists only for direct store callers during the asynchronous reload.
6. **M8's reachability.** pdf.js always assigns an annotation id, either the
   PDF reference or a generated `annot_...` value
   (`node_modules/pdfjs-dist/build/pdf.worker.mjs:51947-51972`), so the
   positional fallback is reachable only through mocks, alternate adapters, or
   upstream changes.
7. **L2's production impact.** Normal opens retain a working-copy path, which
   the store identity prefers
   (`runtime/sessions/createPdfAnnotationSession.ts:292-295`), and proxy
   replacement recreates the annotation application, so entities do not
   survive a collision in normal workspace flows.
8. **One M9 citation.** `createDocumentPersistence.ts:531-534` does set
   `state.error`; several persistence failures also surface through
   `WorkspaceDocumentAlerts.vue:4-10`. The reporting gap is real but narrower
   than cited (see M9 below).
9. **L1's exposure.** With a workspace sink attached (normal production), the
   raw `undoAnnotation`/`redoAnnotation` exposes read empty local stacks and
   no-op (`runtime/annotations/usePdfAppAnnotationHistory.ts:65-70,308-327`).
   No in-repo caller invokes them.
10. **L6's granularity.** The 220 ms debounce coalesces fast typing
    (`app/modules/workspace-shell/composables/useAnnotationNoteWindows.ts:339-363`);
    history gets one entry per quiet-period commit, not per keystroke. The
    eviction pressure on the 128-deep ledger remains for slow typing.

Audit open questions closed by verification:

- **Embedded-shape cache revision tokens.** Every page mutation bumps the
  token. Electron delete, reorder, insert, insert-file, rotate, crop, and
  remove-crop route through `transitionPageMutation`
  (`electron/features/page-ops/main/pageOpsMainBindings.ts:143-180,677-688`);
  browser mutations finish through `writePageMutationResult`
  (`app/platform/browser-api/createBrowserPageOpsCapability.ts:258-271`).
  Extract writes a new destination and workspace split is pane handling, not a
  page mutation. Refuted as a missing bump; a narrower in-flight fencing note
  is V3 below.
- **Deferred-delete undoability.** Confirmed undoable. The unwrapped
  `deleteCanonicalAnnotation` call still registers a before/after history
  entry through the store's own commit
  (`annotations/domain/annotationStore.ts:426-430,844-880`), pushed
  immediately when no transaction is active
  (`runtime/annotations/usePdfAppAnnotationHistory.ts:123-129`). What it lacks
  is atomicity with the pdf.js/DOM effects (V6 below).
- **Overlapping save transactions (Q1)** and **orphan editor after undoing a
  create (Q2)**: see "Resolved open questions" below.

Found during verification, not in the audit:

- **V1.** Per-page parse failures are worse than the audit's footnote: the
  failed page is counted as completed
  (`annotations/bridge/pdfjs-runtime/useAnnotationSync.ts:526-539`), the
  partial snapshot carries no failure field and is cached (`:553-559`,
  `:647-678`), and debug logging sits below the default threshold
  (`app/utils/browserLogger.ts:35,253-276`). Cache reuse preserves the
  omission beyond "the next sync".
- **V2.** The status bar has no failure state (idle, saving, dirty, clean
  only: `usePageStatusBar.ts:234-275`), so a failed save of an
  already-clean-looking document can present as clean.
- **V3.** In-flight embedded-shape imports are fenced by import token and
  path, not document revision
  (`runtime/annotations/useManagedEmbeddedPdfShapes.ts:414-418,631-638`).
  Completed cache entries are revision-safe; an in-flight old scan is not.
- **V4.** L8 is reachable through a first-class setting: root font size
  follows `--app-ui-scale` with presets 0.9/1.1/1.25
  (`app/assets/css/main.css:1085-1087`, `app/composables/useUiScale.ts:21-25`,
  `SettingsGeneralPanel.vue:55-67`). Row stride becomes ~100.8/123.2/140 px
  against a fixed 112 px virtual height.
- **V5.** The direct parser used at save finalize has no size assertion; the
  96 MiB guard lives only in the worker client
  (`engine/pdf-embedded-shape-annotations/embeddedShapeAnnotationsWorkerClient.ts:96-105`).
- **V6.** Deferred delete's tombstone, DOM removal, cache removal, and page
  invalidation are separate operations with no spanning transaction; visual
  effect failures are logged without rollback
  (`createPageAnnotationDeleteActions.ts:66-85`,
  `useAnnotationMutationVisualEffects.ts:110-125`).

## Disposition summary

| ID | Audit rating | Verified status | Corrected rating | Priority | Decision |
| --- | --- | --- | --- | --- | --- |
| H1 | High | Partial: focus dead, delete works | Medium | P1 | Match sidebar shape rows on `annotationId`; regression test first. |
| H2 | High | Confirmed | High | P1 | Propagate real creation success to callers; surface failures. |
| M1 | Med-High | Partial | Medium | P1 | Rebase outstanding history snapshots at `acknowledgeSave`; failing test first. |
| M2 | Med-High | Partial: shielded in production | Low | P3 | Pin the shield (page op clears annotation history) with a test; no code change. |
| M3 | Medium | Partial: orphans transient | Low | P3 | Add direct test: `reconcileEditorPresence` tombstones unbound transients. |
| M4 | Medium | Partial | Medium | P2 | Landed (#101): unedited Square/Circle rects are preserved, not rewritten. |
| M5 | Medium | Refuted | None | No action | pdf.js never yields `[]`; optional one-line guard if touching the file. |
| M6 | Medium | Confirmed | Medium | P1 | Filter sink-mode forget by annotation ids instead of source-wide reset. |
| M7 | Medium | Confirmed | Medium | P2 | Truncation flag + warning + completeness metadata on snapshots. |
| M8 | Medium | Partial: not reachable via pdf.js | Low | No action | Record reachability; revisit only if a non-pdf.js source appears. |
| M9 | Medium | Partial | Medium | P1 | Report `not-saved` outcomes through the same surfacing as thrown saves. |
| M10 | Medium | Partial: conditional, unguarded | Medium | P2 | Landed (#103): save priming runs in the worker client under its size guard. |
| M11 | Low-Med | Refuted as truncation | Low | P3 | Fold a user-visible rejection signal into the H2/M9 surfacing work. |
| L1 | Low | Partial: near no-op in workspace mode | Low | P3 | Delete or gate the raw undo/redo exposes. |
| L2 | Low | Partial: impact refuted | Low | P3 | Key store identity by Blob instance (WeakMap) like the snapshot side. |
| L3 | Low | Partial | Low | P3 | Reschedule the debounced persist when `saving` clears. |
| L4 | Low | Confirmed | Low | P3 | Surface note-window delete misses like the instrumented sibling path. |
| L5 | Low | Partial | Low | P3 | Set `estimatedBytes` on canonical snapshot commands when touching history. |
| L6 | Low | Partial | Low | P3 | Coalesce successive note-text commands per annotation, or accept. |
| L7 | Low | Confirmed | Low | P3 | Landed (#101): stale `/IC` deleted when updating Line dicts; `/LE` unchanged. |
| L8 | Low | Confirmed, reachability understated | Medium | P1 | Derive virtual row stride from the effective root font size. |
| V1 | — | Confirmed | Medium | P2 | Bundle inventory-completeness status with M7. |
| V2 | — | Confirmed | Medium | P1 | Fold a failure state into the M9 surfacing slice. |
| V3 | — | Confirmed, narrow | Low | P3 | Landed (#103): the in-flight import fence compares the document revision. |
| V4 | — | Confirmed | — | — | Evidence for L8's P1; no separate item. |
| V5 | — | Confirmed | Low | P2 | Landed (#103) as part of the M10 slice. |
| V6 | — | Confirmed | Low | P3 | Closed in #100: e2e asserts undo of a deferred delete restores editor/DOM state. |
| Q1 | Risk (unverified) | Proven: print bypasses the save lease | Medium | P1 | Route dirty print through the document operation lease; add a race test. |
| Q2 | Risk (unverified) | Refuted by experiment: editor removal precedes the canonical delete | Low | P2 | Closed in #100: removal mechanism recorded, boundary regression tests added, in-flight sync fenced. |
| V7 | — | Confirmed (#100) | Medium | P2 | One authored create leaves two undo steps; the first leaves the document dirty with nothing visible left. Needs the store-side fix, not a history transaction. |

## P1 items

### H2, creation success is reported unconditionally

`useAnnotationHighlight.ts:356-367` hard-codes `createdAnnotation = true`
after submitting the canonical intent; mode-switch and editor failures are
caught, logged at debug level, and still return success (`:565-601`).
`createTextMarkupFromText` exposes the value as `created` (`:763-768`), and it
is consumed by the workspace automation expose
(`app/modules/workspace-shell/expose/createWorkspaceExpose.ts:460-465`) and
the document agent (`agent/useDocumentWorkspaceAgent.ts:763-777`). A point
comment also treats `true` as success and skips its fallback
(`useAnnotationHighlight.ts:940-949`).

Acceptance checks:

1. The function returns the actual outcome: intent submitted, editor bound, or
   failed with a reason.
2. Automation and agent callers receive the failure.
3. Unit tests cover mode-switch throw, retry exhaustion, and null editor
   results; all currently pass against the hard-coded flag and must fail
   against it after the change.

### M9 and V2, not-saved outcomes bypass reporting

`useWorkspaceSaveService.ts:931-955` returns `false` for `status:
'not-saved'` without setting an error or showing a toast; the toast lives only
in the exception handler (`:1080-1111`). Reachable producers include failed
open-note persistence (`:1030-1042`), validation rejection (`:292-317`), and
optional capability failures
(`createDocumentPersistence.ts:609-611,659-661`). The status bar has no
failure state (`usePageStatusBar.ts:234-275`), so a failed clean-looking save
presents as clean.

Acceptance checks:

1. Every `not-saved` return sets state or user-visible feedback equivalent to
   the thrown-save path.
2. A service-level test asserts the surfacing for at least validation
   rejection and note-persistence failure.
3. The M11 silent rejection (cross-page selection) reuses whatever surfacing
   primitive this slice introduces, or documents why not.

### H1, sidebar shape focus matches a field that is never set

`tools/usePdfShapeTool.ts:110-121` matches shapes against
`comment.appAnnotationId`; shape summaries never carry it
(`engine/annotations/shape-annotation-comments/toShapeAnnotationCommentSummary.ts:30-49`),
and no enrichment site exists (decisive repo-wide trace; the only
sidebar-capable enrichment, `annotationApplication.ts:370-418`, has no call
site). Row click opens the sidebar and sets the active key, then returns
before focusing (`usePdfAnnotationCommentActions.ts:54-57`).

Acceptance checks:

1. A regression test drives a shape summary through
   `findShapeForAnnotationComment` and fails before the fix.
2. Fix by matching on `annotationId` (or by setting `appAnnotationId` in the
   summary factory); pick one and delete the dead alternative.
3. Fold L4 in: the note-window `deleteAnnotationById` miss logs or surfaces
   like `createPageAnnotationDeleteActions.ts:88-97`.

### M6, sink-mode forget wipes unrelated annotation history

Local mode filters forgotten commands by id; sink mode resets the entire
`annotation` source (`runtime/annotations/usePdfAppAnnotationHistory.ts:131-145`,
`app/modules/workspace-shell/composables/useWorkspaceCommandLedger.ts:62-99`).
The sink is attached in normal production
(`useWorkspaceOrchestration.ts:228-249`), and forget runs on deleted-shape
cleanup, shape replacement, and unmatched-import cleanup
(`annotations/domain/annotationStore.ts:417-424,936-945,972-994`).

Acceptance checks:

1. Ledger gains id-scoped removal within a source; sink-mode forget uses it.
2. A test registers two annotation commands, forgets one id, and asserts the
   other remains undoable (the current suite cannot detect this).

### L8, fixed 112 px virtual stride under UI scaling

`PdfAnnotationCommentsList.vue:216-223` fixes `itemHeight: 112`; rows are
rem-based (`:515-531`, `app/assets/css/main.css:260-262`) and root font size
follows the UI scale presets 0.9/1.1/1.25 (V4). At non-default scale the list
overlaps or gaps.

Acceptance checks:

1. Row stride derives from the effective root font size (or the row height
   moves to pixels; pick one and state why).
2. A test covers at least one non-default scale.

### M1, history snapshots go stale across save acknowledgement

`acknowledgeSave` adds `persistedRevision`, binds `pdfRef`, and rebases the
semantic baseline without touching history
(`annotations/domain/annotationStore.ts:721-751`); commands hold absolute
before/after clones and replay them wholesale (`:844-880,901-928`). Redo of a
pre-save create restores `persistedRevision: -1` without `pdfRef`, flipping
the entity dirty. The audit's duplicate-on-next-save consequence is
conditional: save verification also matches canonical id, `pdfName`,
`pdfjsUid`, `elementId`, and sticky-note semantic fallback
(`annotationApplication.ts:642-709`), but some delete serialization does key
off `pdfRef` (`engine/pdf-serialization-operations/serializePdfEdits.ts:16-55`).

Acceptance checks:

1. A failing unit test first: edit, save, undo, redo, then assert
   `persistedRevision` and `pdfRef` survive redo.
2. Preferred fix is rebasing identity fields into outstanding snapshots at
   `acknowledgeSave` (the audit's rebase option); wholesale replay stays.
3. The M2 shield gets pinned in the same slice: a test asserting a structural
   page op clears annotation history via the proxy-swap watcher.
4. An e2e extends `annotationLifecycle` to assert identity fields, not just
   counts and dirty bits.

### Q1, dirty print runs a save transaction outside the document lease

Evidence and mechanism in "Resolved open questions" below.

Acceptance checks:

1. The dirty-print path acquires the same document operation lease as saves,
   split capture, page mutations, and shutdown flush before calling
   `runSaveTransaction`.
2. A test holds two transaction commits open and asserts the second waits (or
   fails) instead of both passing `assertAnnotationSaveCurrent()` across one
   acknowledgement.

## P2 items

### Q2, orphan editor and entity resurrection after undoing a create

Closed in #100 without the conditional fix: the experiment refuted the orphan.
See "Resolved open questions" below for the recorded removal mechanism, the
regression tests that pin it, and V7, the defect the experiment did surface.

### M4, import clamping rewrites off-page geometry

Clamping happens twice on import
(`engine/annotation-geometry/toMarkerRectFromPdfRect.ts:124-129`,
`normalizeMarkerRect.ts:16-30`) and the clamped rect is written back when
shape state is dirty (`useWorkspaceSaveService.ts:458-467`,
`applyShapeAnnotations.ts:206-221`). Left/top crossings shift the rectangle
rather than intersecting it. Ink and polyline points are not clamped, so
behavior is type-dependent. Requires editing any shape in the document, then
saving, to damage an untouched off-page shape.

Order: fixture first (an embedded Square straddling the trim box through
open, unrelated shape edit, save, reopen), then either stop clamping imported
geometry or only serialize rects whose marker geometry actually changed.

**Landed (#101), with L7.** The second option: import still clamps, because
the overlay renders in the unit page box, but a Square or Circle whose marker
geometry is unchanged keeps the rect the file already carries. Both writers
decide this the same way: replay the import projection over the annotation's
own rect and compare it with the live marker rect
(`engine/serialization/pdf-serialization-shape-annotations/isImportedShapeRectUnchanged.ts`,
`native/pdf-page-ops/src/shapes.rs`, `is_imported_shape_rect_unchanged`). An
edit of any size a pointer can produce fails that comparison and serializes
normally. The native reader resolves `/Rect` through the document, so an
indirect array, or indirect numbers inside it, reads as an unchanged rect
instead of as no rect at all; without that, the preservation branch would be
skipped exactly where it matters. Coverage:
`tests/unit/app/modules/pdf-viewer/serialization/embeddedShapeRectPreservation.test.ts`
(serialized route, Square and Circle, including repeated open-save cycles) and
the shape cases in `native/pdf-page-ops/src/tests/markup_shapes.rs` (full
rewrite, incremental append, and indirect rects). L7 rode along: both writers
now delete `/IC` when updating a Line, and the tests pin that a Polygon fill
survives.

### M7 and V1, inventory completeness is silent

Global caps break silently and the truncated snapshot is cached beyond
revision changes (`useAnnotationSync.ts:125-129,500-511,553-559,590-661`);
failed pages count as completed (`:526-539`). Add a completeness field to the
snapshot, warn on truncation or page failure, and surface it wherever the
sidebar shows loading state. Tests: a capped scan and a failing page both
produce the flag and the warning.

### M10 and V5, save-finalize parses on the UI thread without a size guard

`useManagedEmbeddedPdfShapes.ts:700-714` imports the direct parser at save
priming; runs only for serialized saves with dirty shape state or native saves
with shape mutations (`useWorkspaceSaveService.ts:550-560,739-748`), so it is
conditional, but the direct call has no 96 MiB assertion and the 64 MiB
working-copy guard does not cover automation or native paths. Route priming
through the worker client and inherit its guard; test that priming uses the
worker.

**Landed (#103), with V3.** Priming calls
`importEmbeddedShapeAnnotationsUsingWorker`, so the whole-document scan leaves
the renderer thread and inherits the 96 MiB assertion. It keeps ownership of
the bytes, which are still on their way to disk, so the worker receives a
copy. A refusal is the point of the change: priming then returns no
preparation token, and a serialized save persists the file but leaves shape
state dirty instead of declaring clean a baseline nothing established. The
token is bound to the store and save frontier that started the save, and the
clean mark now goes through it, so a save of a document the viewer has since
replaced cannot mark the current one's shapes saved. In-flight priming is
registered and aborted when the viewer adopts a different working copy or the
composable is disposed; a save that republishes the same working copy under a
new revision is not cancellation and survives. V3 rode along:
`isStaleEmbeddedShapeImport` now also compares the document revision token, so
an in-flight scan started before a page mutation is fenced, not only a
completed cache entry. Coverage:
`tests/unit/app/modules/pdf-viewer/runtime/annotations/managedEmbeddedShapeSavePriming.test.ts`
and the shape-priming cases in
`tests/unit/app/modules/workspace-shell/composables/file-operations/workspaceSaveServiceNativePersistence.test.ts`.

## P3 batch

Fold these into work that already touches their area; none justifies a
standalone change:

- M2 pin test and M3 reconciliation test (with the M1 slice).
- M11 rejection signal (with the H2/M9 surfacing slice).
- L1: delete the raw `undoAnnotation`/`redoAnnotation` exposes
  (`createPdfAnnotationSession.ts:1015-1021`,
  `usePdfViewerPublicApiController.ts:251-255`); they are a no-op with a sink
  attached and have no in-repo caller. Prefer deletion per the design charter.
- L2: WeakMap-keyed store identity for pathless blobs, mirroring
  `createPdfAnnotationSession.ts:119-141`.
- L3: reschedule the note persist when `metadata.saving` clears
  (`useAnnotationNoteWindows.ts:379-388,417-422`).
- L4 (with H1). L5, L6 (with any history work). L7: landed with #101, in both
  the pdf-lib and the native shape writers.
- V3: landed with #103; the in-flight import fence now compares the document
  revision token as well as the import token and working copy path.
- V6 (done, #100): `annotationLifecycle.e2e.test.ts` asserts that undoing a
  deferred delete of a persisted highlight restores the editor node and the
  canonical entity under its persisted identity, with no save in between.

### L6 decision, taken with the M1 slice (#98): accept per-commit entries

Successive note-text commands stay separate undo steps. The note window
debounces keystrokes into one commit per quiet period
(`app/modules/workspace-shell/composables/useAnnotationNoteWindows.ts:339-363`),
so each entry already marks a pause the user can recognise, and merging them
would let one undo swallow a whole typing session. Merging would also have to
rewrite the top of the shared workspace timeline, where the previous entry may
belong to another producer, weakening the ordering that timeline exists to
keep. The eviction pressure the audit worried about is answered by L5 instead:
canonical snapshot commands now carry the bytes they retain
(`annotations/domain/annotationStore.ts`, `estimateRetainedAnnotationBytes`), so
the ledger's byte cap prices note edits honestly rather than at the flat 1 KiB
default. The boundary is pinned by
`tests/unit/app/modules/pdf-viewer/annotations/annotationStoreSaveIdentityRebase.test.ts`.

## Resolved open questions

### Q1, overlapping save transactions: proven, print bypasses the lease

Normal saves, split capture, page mutations, and shutdown flush all serialize
through the document-wide FIFO lease
(`app/modules/workspace-shell/document-sessions/workspaceDocumentController.ts:403-430`;
save entry at `useWorkspaceSaveService.ts:1001-1026`; split at
`useWorkspaceSplitPayload.ts:111-155`; page ops at
`runtime/composables/pdf/usePageOperations.ts:262-275`; shutdown via
`usePageSaveOrchestration.ts:347-349`). Dirty print calls
`pdfViewerRef.runSaveTransaction` directly with no lease
(`useWorkspaceOrchestration.ts:722-741,817-835`), and `runSaveTransaction`
itself has no single-flight guard and awaits several interleaving points
(`runtime/save/usePdfViewerSaveTransaction.ts:451-520,631-665`).

The CAS race the audit feared is real: the frontier baseline hashes only
`{id, revision, deleted, pageIndex}`
(`engine/annotations/domain/annotationEntity.ts:164-171`), and
`acknowledgeSave` leaves `revision` unchanged, so a second frontier can pass
after the first acknowledgement (`annotationStore.ts:721-751,781-815`).
Mitigations: print returns bytes without `commitAnnotationSave`, and backend
writes carry document-revision checks and are serialized per document
reference. Whether the race can produce duplicate durable bytes is still
open; the guard hole itself is proven. Disposition: P1, route dirty print
through the same lease.

### Q2, orphan editor after undoing a create: refuted by the experiment (#100)

The closing experiment ran as specified: an e2e MutationObserver records the
highlight nodes a replay removes, the editor-layer identity, the DOM counts,
and the canonical projection at the synchronous undo, after two animation
frames, and in a following macrotask
(`tests/e2e/electron/helpers/viewerAnnotations.ts`,
`clickHistoryActionAcrossAnimationBoundaries`). No orphan reproduces, for
either authored creation path.

Removal mechanism, recorded so the next reader does not re-derive it:

- **Highlight and drawings.** `AnnotationEditorLayer.add` calls
  `editor.onceAdded`, and `HighlightEditor.onceAdded` / `DrawingEditor
  .onceAdded` call `layer.addUndoableEditor(this)` when the editor is not an
  existing annotation, which reaches `uiManager.addCommands({cmd: rebuild, undo:
  remove})`. That command carries no `__evbSkipAppHistory` marker, so the
  bridge records it as an app executor command
  (`annotations/bridge/pdfjs-runtime/useAnnotationEditorBridge.ts`, `addCommands`
  interception). It sits above the canonical create in the same stack, so the
  first undo runs PDF.js' own removal synchronously and the editor node is gone
  in the same task. The replay effect's presence reconciliation then sees the
  editor absent and tombstones the still-transient entity
  (`runtime/sessions/createPdfAnnotationSession.ts` replay effect →
  `annotationStore.reconcileEditorPresence`), so the canonical entity leaves
  the projection in that same task too. The `skipAppHistory` pair the bridge
  installs from the storage hook is a redundant second PDF.js entry for this
  path and is never replayed.
- **FreeText sticky notes.** `FreeTextEditor.onceAdded` installs no PDF.js
  undo command, so the canonical entry is the only app history entry. The
  anchor editor is not orphaned because it is projected from canonical state
  rather than owned by PDF.js history: the canonical delete takes the anchor
  with it inside the same task. The experiment pins this by counting
  `.freeTextEditor` nodes at every boundary.

Regression tests (`tests/e2e/electron/annotationLifecycle.e2e.test.ts`):
"keeps an undone toolbar highlight create removed across frames and the
deferred sync", "keeps an undone sticky note removed across frames and the
deferred sync", and V6's "restores the editor, DOM, and canonical entity when a
deferred delete is undone". Each drives a real comment sync to completion after
the undo and asserts that nothing the observer recorded as removed comes back.
"To completion" is measured, not waited out: the renderer publishes an
automation-only sync ledger (`app/utils/createAnnotationSyncAutomationBarrier.ts`,
inert without the renderer automation grant) counting requested, running, and
serviced comment syncs, and the two undo scenarios block on
`waitForAnnotationSyncIdle` until a sync requested after their mutation has
finished its awaited PDF snapshot with nothing left queued or debounced. The
observer and every count it is compared against are scoped to the active
workspace host, so an inactive tab's mounted viewer cannot answer for the one
under test.

One hole was real and is closed: a comment sync reads the editor layer
synchronously and then awaits the PDF snapshot, so a replay landing inside that
await could apply a pre-replay editor scan on top of the result. Because an
editor summary carries `appAnnotationId` from the editor's facade state,
`ingestLegacySummaries` would mint the undone annotation back under its own
canonical id. The replay effect now retires such a scan
(`useAnnotationSync.discardInFlightSync`), keeping the parsed PDF snapshot,
which a replay does not invalidate. Pinned by
`tests/unit/app/modules/pdf-viewer/runtime/annotations/useAnnotationSync.test.ts`,
"does not apply an editor scan collected before an annotation history replay".

### V7, one authored create leaves two undo steps

Found while running the Q2 experiment. A toolbar highlight registers the
canonical create and PDF.js' own `addUndoableEditor` command as two independent
app history entries. The first undo pops the PDF.js entry and removes the
editor; the presence reconciliation tombstones the entity, so nothing is
visible any more, but the document stays dirty and a second undo is still
queued for the canonical entry. Sticky notes show the same two-step shape.
Evidence: with the fixture freshly opened and one highlight created, the
toolbar reports `canUndo: true, canSave: true` after the first undo with
`annotationComments: []`, and only the second undo reports `canSave: false`.

A history transaction around the authored creation is *not* the fix. It was
tried and reverted in #100: merging the two entries makes one undo reach the
canonical hard delete, and hard-deleting an entity the file already holds drops
the persistence identity that survives an undo only while the save
acknowledgement has not cleared it
(`annotations/domain/annotationPersistenceIdentityLedger.ts`, `clear`). The
"keeps highlight undo and redo coherent after saving" e2e fails deterministically
under that change: after undo, save, redo, save the file holds the highlight but
the canonical projection holds nothing. The fix belongs in the store, where undo
of a create must tombstone rather than hard-delete an entity whose persistence
record says the file holds it. Sequence it with the M1/#98 history work.

## Suggested implementation order

1. **Surfacing slice** (#91): H2 + M9 + V2, with M11's signal riding along.
   One shared failure-surfacing primitive covers the audit's "silent failure
   is a pattern" synthesis without inventing per-site toasts.
2. **Sidebar shape slice** (#92): H1 focus fix + L4, regression tests first.
3. **Save integrity slice** (#93): Q1's print lease. Small, isolated, and it
   closes the only proven overlap path before any history work changes
   timing.
4. **History integrity slice** (#97, #98): M6, then M1 with the M2/M3 pin
   tests and the L1/L5/L6 fold, then the Q2 diagnostic (#100, blocked by #98),
   which refuted the orphan and left V7 for a later store-side step. M1 is the
   deepest change; its failing tests define the contract before the rebase
   lands.
5. **Layout slice** (#99): L8.
6. **P2 hardening**: M4 fixture then fix (#101, with L7); M7+V1 completeness
   (#102); M10+V5 worker routing (#103, with V3).
7. **P3 batch**: homeless leftovers L2 + L3 in #104; the rest ride their host
   slices above.

A finding closes when the corrective change and its regression test land and
this ledger's row is updated with the commit. Verification transcripts for
this ledger live outside the repo (`/tmp/codex-skill/annot-*-last.md`,
session artifacts); the evidence that matters is re-derivable from the
citations above.

## Acceptance entries

### 2026-09-05, #350 legacy saved-note compatibility

Status: In progress. Claimed by `evb0110` in Project 4. The issue is a child
of #170 and is assigned to the Editor lane and Other box. It remains open until
candidate and integrated-main verification pass.

The supplied recording and logs reproduce deletion failures for saved legacy
EVB notes on main at `25c6c974fd2eee8d3cb23c35abf49ecc33520642`. A real
Electron pointer reproduction also fails on
`2aecf52284ee29fdc818e03e45509705731314b6`. Both the sidebar Delete action
and the note-window Delete action leave the note count unchanged. The warnings
report `source=pdf`, `uid=null`, stable keys `ann:0:10909R` and
`ann:0:10916R`, and no resolvable editor.

The minimized fixture is
`/home/ubuntu/rescue-research/annotation-audit-20260905/legacy-notes-minimal.pdf`
(3,153 bytes, SHA-256
`f6f4a9800e5cd65891b57136000e59f083fb0a91aa2fe2ee4811903e60a130da`). It
contains two `/FreeText` plus `/Popup` legacy notes with `evb-note:` `/NM`
values, tiny marker rectangles, and blank zero-BBox appearances. The reported
book and recording were transferred privately to this VPS for the audit and
were not uploaded publicly.

Acceptance must prove canonical import and one durable identity across the
selection, sidebar, overlay, and history; sidebar and popup deletion with the
neighbor preserved; undo and redo; popup and reply cleanup; two save/reopen
cycles without resurrection; ADR 0003 migration of an edited legacy note to
`/Text`; preservation of an untouched legacy note; and comparison with a native
`/Text` note. The first implementation check runs this minimized fixture on
candidate `7466fc613f38460e08fe04beff54b46786cd6ba5` before any fallback is
added. Candidate and integrated-main SHAs and red/green results will be added
here when the gate closes.

The candidate source comparison confirms that the cutover already recognizes
legacy FreeText plus Popup plus blank AP notes, preserves their NM and PDF
object reference, projects them into the canonical persisted Text-note view,
and uses the embedded/native delete route. This is source evidence only. The
old editor bridge must not return to this path.

An early candidate pointer smoke run used the private source paths directly.
It passed against the two-note reported file, but the app wrote incremental
updates into both source files. The original files were recovered by proving
that the expected byte-length prefixes still matched their supplied SHA-256
values, then restoring those exact prefixes. No result from that contaminated
run counts as acceptance. Every later mutating case must open a fresh working
copy.

The restored fixture checks are now:

- `legacy-notes-minimal.pdf`: 3,153 bytes, SHA-256
  `f6f4a9800e5cd65891b57136000e59f083fb0a91aa2fe2ee4811903e60a130da`.
- `reported-notes.pdf`: 2,833,504 bytes, SHA-256
  `8398f0bce24e1d229810f29dc7844aff68c1bbebb2d9e0527df0a801d1ccbd36`.

The first clean minimal-file run also exposed a fixture-routing question. The
original file and its object graph must be checked before calling a second
note reachable or orphaned. That check remains part of worker 1's result.

## Parallel acceptance workstreams

On 2026-09-05 the coordinator reused four completed Luna read-only lanes and
reassigned them under this thread. Two other completed lanes were retired.
Each worker was told to preserve concurrent edits, avoid shared helpers and
fixtures, and leave commits and GitHub state to the coordinator.

| Worker | Scope and exact write ownership | Shared dependency | Current result |
| --- | --- | --- | --- |
| Peirce | Test environment and session readiness. `tests/e2e/electron/performanceProfileVisuals.e2e.test.ts`, `tests/e2e/electron/inactiveDjvuTabs.e2e.test.ts` for the cancellation case, `app/utils/performanceProfile.ts`, `app/plugins/performance-profile.client.ts`. | Must report changes needed in shared Electron helpers, runner, or pressure configuration. | Complete. The cancellation reproduction was a collected `page.evaluate` promise and the synchronous dispatch rewrite plus pre-deactivation image filter passed at `2026-09-06T00-13-48-965Z-3085920-d24dbce3`. The profile failure was traced to sandboxed preload decoding and fixed by the coordinator in the preload decoder. |
| Euler | Annotation lifecycle and #350. `tests/e2e/electron/legacyNote350.e2e.test.ts`, `tests/e2e/electron/annotationLifecycle.e2e.test.ts`; product edits only if a focused proof requires `useAnnotationMutationService.ts` or `createPageAnnotationDeleteActions.ts`. | Coordinator owns shared helpers, fixture generators, save/session files, ledger, and GitHub state. | Complete. Clean fresh-copy legacy coverage passed for the minimized and supplied 383-page fixtures, with the virtualized hidden-sidebar-row failure classified and corrected in the test helper. |
| Avicenna | Document opening and native services. `tests/e2e/electron/viewerSmoke.e2e.test.ts`, `tests/e2e/electron/djvuPrintHandoff.e2e.test.ts`, `tests/e2e/electron/inactiveDjvuTabs.e2e.test.ts`; product edits only in `app/modules/djvu-viewer/**`, `app/platform/browser-api/djvujsLoader.ts`, or `app/modules/workspace-shell/composables/document-session/nativePdfMutationCommit.ts` after proof. | Shared helper or runner changes return to the coordinator. | Complete. Added a settled sidebar-wrapper geometry wait in `viewerSmoke.e2e.test.ts`; the focused candidate passed. PNG, scan-cleanup, and print passed after native-tool provisioning. Cancellation remains with Peirce. |
| Mendel | Viewport and navigation. `tests/e2e/electron/inactivePdfTabs.e2e.test.ts`, `tests/e2e/electron/prBlockingSmoke.e2e.test.ts`, `tests/e2e/electron/squigglyMarkup.e2e.test.ts`; product edits only in the assigned navigation, viewport, document-viewport, anchor-retention, and text-markup model directories. | Annotation-layer overlap is reported to the coordinator and worker 1. Shared helpers remain coordinator-owned. | Complete. No candidate-only split-pane regression was established. The squiggly failure was an obsolete absolute-zoom expectation, corrected to use the rendered CSS scale factor, and passed at `2026-09-05T21-28-37-686Z-2713498-6cd81665`. The page-7 reset passed its focused late-page check at `2026-09-05T20-40-02-811Z-2627764-2cf3b15c` and again under the final candidate at `2026-09-06T00-17-29-266Z-3096073-b93a3546`. |

The coordinator queues expensive Electron and large-document runs centrally.
Workers begin with source analysis and lightweight checks and return each
failure's trigger, assertion, baseline/candidate distinction, root cause,
smallest justified change, focused output, touched files, and remaining risk.

Mendel's source comparison found the three owned E2E failures unchanged between
baseline `3924b6a92` and candidate `7466fc613`; the relevant viewport unit checks
passed. The split-pane run had no blank, loading, disconnect, page-change, or
thumbnail-reset signals despite `maxAnchorDrift=0.379`. The page-7 reset trace
showed the viewport authority at page 12 while page 7 was evicted. The
squiggly timeout did not capture settled width or mounted-page evidence. No
test assertion was weakened and no product edit was justified.

Avicenna's completed audit found that the candidate and evidence roots lack the
native image-combine and scan-cleanup binaries required by the PNG and scan
cleanup tests. Those tests correctly reject the JavaScript fallback. The DjVu
print run reached native page reading and then logged `TypeError: Object has
been destroyed`; its retained artifact did not prove the reported combiner
failure. The inactive-DjVu logs do not contain the asserted trusted-scroll
count or the `Promise was collected` error. These failures need a centrally
queued focused run or native-tool provisioning before any test assertion is
changed.

The coordinator then staged the native E2E tools with gate
`2026-09-05T20-19-37-267Z-2591018-11d091c9.ndjson`. On the provisioned
candidate, the PNG entry test passed at gate
`2026-09-05T20-22-12-107Z-2595476-fb916845`, the Scan Cleanup skeleton and
detection test passed at `2026-09-05T20-23-26-717Z-2597030-25c61c8c`, the
native detail-tile test passed at `2026-09-05T20-24-44-030Z-2598375-bccecaad`,
and the DjVu print handoff passed at
`2026-09-05T20-25-50-368Z-2599601-b90a896b`. The cancellation test still
fails with `Promise was collected` at
`2026-09-05T20-27-47-100Z-2602475-ecb706a4` and is now owned by Peirce for
session-lifetime diagnosis.

After Avicenna's audit, the focused DjVu sidebar run reproduced the documented
opening transition race at gate `2026-09-05T20-30-18-988Z-2606365-eb744b4d`:
the inner sidebar was open while its outer wrapper still reported zero width.
The worker added a local settled-boundary wait in the owned test, retaining
the existing one-pixel geometry assertions. The corrected candidate passed at
`2026-09-05T20-35-40-068Z-2617122-04dccbb4`.

The focused squiggly-markup run remains red at
`2026-09-05T20-31-58-222Z-2609410-5b63ac2e`. It times out at the existing
`waitForPageWidthAtZoom` assertion after the 50% transition. Mendel is
diagnosing the settled page width and effective zoom without weakening that
assertion.

### 2026-09-05, candidate acceptance follow-up

The private source fixtures were rechecked after all mutating runs. The
3,153-byte minimized fixture still hashes to
`f6f4a9800e5cd65891b57136000e59f083fb0a91aa2fe2ee4811903e60a130da`, and the
2,833,504-byte supplied fixture still hashes to
`8398f0bce24e1d229810f29dc7844aff68c1bbebb2d9e0527df0a801d1ccbd36`.
Every mutating test used a fresh temporary copy. The book and recording were
transferred privately to this VPS for audit and were not uploaded publicly.

Candidate `7466fc613f38460e08fe04beff54b46786cd6ba5` passed the complete #350
suite, four tests, at gate
`2026-09-05T21-27-05-508Z-2710062-417ebce7`. The minimized lifecycle test
proved real pointer selection, sidebar selection and deletion, note-window
deletion, undo and redo, editing with stable legacy identity, migration of the
edited note to `/Text`, preservation of the untouched `/FreeText` neighbor,
save and two reopen cycles without resurrection, and cleanup of the parent and
`/Popup`. The reply fixture also passed with the reply removed and the neighbor
intact. The supplied 383-page file passed its focused acceptance at
`2026-09-05T21-26-02-447Z-2708424-400c26af` and the full candidate suite.

The first clean minimal run initially failed because the test selected a hidden
zero-sized virtualized sidebar row. The helper now selects only an onscreen
row with a nonzero button rectangle. That was a fixture-routing failure, not a
legacy-note product failure. The candidate source comparison and the green
real-pointer run also confirm that the annotation layer's captured click keeps
the canonical legacy identity through selection and note-window opening. The
retiring PDF.js editor bridge was not restored.

The remaining performance-profile failure had a separate environment cause.
The sandboxed preload could not use Node `Buffer`, so it discarded the valid
host-profile argument and the renderer detected the VPS as high tier. The
browser-safe decoder fix covers both the host-profile and diagnostics-policy
arguments. Unit coverage passed 25 tests, and all low, medium, and high visual
profile checks passed at gate
`2026-09-05T21-53-43-169Z-2769520-30f305a2`.

Integrated-main verification, PR integration, and the remaining #196, #168,
#167, and Project 4 closure checks remain open.

### 2026-09-06, broad regression classification and candidate follow-up

The exact private legacy-note fixture remains unchanged at 3,153 bytes with
SHA-256 `f6f4a9800e5cd65891b57136000e59f083fb0a91aa2fe2ee4811903e60a130da`.
The supplied reported-notes fixture remains unchanged at 2,833,504 bytes with
SHA-256 `8398f0bce24e1d229810f29dc7844aff68c1bbebb2d9e0527df0a801d1ccbd36`.
The source book and recording stayed private on the VPS and were not uploaded
publicly.

The candidate broad regression run at gate
`2026-09-05T23-43-55-184Z-3030339-c030f60c` reported 65 passing tests, 18
intentional skips, and four failures across three files. Focused reruns
separated those failures. The inactive-DjVu cancellation failure was a probe
bookkeeping defect: the observer counted image elements committed before tab
deactivation. The probe now snapshots those elements and counts only new
commits. Its focused rerun passed at
`2026-09-06T00-13-48-965Z-3085920-d24dbce3`.

The inactive-PDF split-close, inactive-DjVu split-close, and PR-blocking page-7
reset failures reproduced only under the broad suite's concurrent load. Their
existing assertions remain unchanged. Each focused rerun passed with the same
candidate behavior at gates `2026-09-06T00-15-28-913Z-3093020-12bb1a6d`,
`2026-09-06T00-16-28-012Z-3094780-fa27f541`, and
`2026-09-06T00-17-29-266Z-3096073-b93a3546`, respectively. The broad failures
remain recorded as load-sensitive risks and require a post-integration broad
run. No failure was waived, no deadline was widened, and no fixture was
substituted.

The sticky-note context-menu fix and canonical-layer test corrections were
focused-green before this follow-up. The candidate also retains the browser
safe preload decoder, native managed-shape save projection, exact large-PDF
fixture routing, and the complete #350 evidence recorded above. Candidate
commit, PR integration, integrated-main verification, and the remaining #196,
#168, #167, and Project 4 closure checks remain open.

### 2026-09-06, split continuity and DjVu transition follow-up

The earlier load-sensitive classification for inactive-DjVu split continuity is
superseded by focused evidence. The integrated branch reproduced two blank
image frames and three page-change frames at gate
`2026-09-06T06-41-03-850Z-3618909-ebd85d47`, with page 18 ending at a maximum
anchor drift of `0.4091786707769391`. The same case passed only when temporary
diagnostics changed timing, so that run is not acceptance evidence.

The focused PDF continuity case passed three times, including real pointer
input, at gates `2026-09-06T06-27-05-694Z-3575012-21e2235d`,
`2026-09-06T06-28-16-378Z-3579115-b3408a39`, and
`2026-09-06T06-33-03-879Z-3592698-71d0eca9`. The integrated candidate now
keeps page-source scroll ownership and raster rendering fenced for the full
resize-transition lifecycle, rather than only while the outer resize prop is
true. The focused DjVu case passed after that change at
`2026-09-06T06-58-35-919Z-3678026-e6b00c48`; the unit check passed 14/14.
Candidate commit is `aba9aa6d`; integration has the corresponding local
commit. Temporary diagnostics were removed. The next required check is the
affected integrated three-file gate, followed by broad regression and exact
large-fixture acceptance after review.

### 2026-09-06, integrated continuity repair and acceptance follow-up

The final continuity diagnosis is now backed by quiet focused runs and the
affected integrated topology. The PDF split-close case had previously failed
with page changes and anchor drift even though the authoritative committed
page was stable. During a resize transition the chassis selected the nearest
visible page, which could be a neighboring page after split geometry changed.
The chassis now prefers the committed or requested page when that page is
mounted, while retaining nearest-page selection for opening and uncommitted
layouts. The new preference has a unit regression covering a mounted page that
is not nearest the viewport centre.

The DjVu split-close case had previously released page-source state while the
resize transition was still active. `retainOnlyPageStates` now defers that
release until the existing settled callback, alongside the existing render and
scroll fences. The guard preserves the current renderer/store architecture and
does not restore the retired PDF.js editor bridge.

| Failure | Last red evidence | Diagnosis and smallest change | Focused green evidence | Next check |
| --- | --- | --- | --- | --- |
| PDF split-close continuity | `2026-09-06T07-21-34-285Z-3770003-cf3991f0`, page-change and drift frames | Capture the mounted committed/requested page as the semantic anchor; keep strict blank, identity, page, and drift assertions | `2026-09-06T07-33-25-638Z-3802533-6e66b3b9`, `07-34-25-830Z-3804037-7bad01d5`, `07-37-16-150Z-3808235-eb6a3795`; integrated gate `2026-09-06T07-43-36-991Z-3820576-96c2194c` | Broad regression and exact 882/2646 acceptance on the final candidate, then integrated-main verification |
| DjVu split-close continuity | `2026-09-06T06-41-03-850Z-3618909-ebd85d47`, two blank and three page-change frames | Defer resident-page eviction through the full resize transition; render and scroll were already fenced | `2026-09-06T07-38-23-818Z-3810011-1624079f`, `07-39-25-751Z-3812431-61b50149`, `07-40-29-832Z-3815007-45fd4a80`; integrated gate `2026-09-06T07-43-36-991Z-3820576-96c2194c` | Broad regression and exact 882/2646 acceptance on the final candidate, then integrated-main verification |
| Warm high-zoom DjVu host count | `2026-09-06T07-02-06-806Z-3689719-105a97dc`, one host under the combined topology | The isolated case passes; the prior one-host result is load-sensitive lifecycle eviction, not evidence for a decoder failure. Keep the two-host contract unchanged and use the integrated gate as the topology check | Isolated focused runs `2026-09-06T07-41-39-933Z-3817142-3477bcd1` and `07-42-40-551Z-3818979-4eaa348b`; integrated gate passed all 15 selected tests | Recheck in broad and large-document acceptance; if it recurs, capture lifecycle temperature, pressure, and host-mount state before changing code or tests |

The exact affected gate `2026-09-06T07-43-36-991Z-3820576-96c2194c` passed 15
tests with five intentional skips across the three affected files. All
temporary debug instrumentation was removed before the passing runs. The
candidate and integration worktrees contain the same three runtime changes;
the candidate also contains the anchor unit regression, which is being mirrored
in integration before commit. The next coordinator gates are targeted lint
and unit checks, review, the broad regression, exact 882-page and 2,646-page
acceptance, and then fresh integrated-main verification. The private book and
recording remain on the VPS and were not uploaded publicly.

### 2026-09-06, zoom-reset page-anchor repair

The post-fix integration broad run exposed a real page-7 reset defect at
`2026-09-06T08-19-14-170Z-3881437-e70f7eb1`. After the zoomed page-7 check, the
reset changed the DOM scale before the deferred coordinator captured its
anchor. The browser clamped the old scroll position to page 12, so the
coordinator recorded page 12 even though page 7 was still the committed
semantic page. The strict test then correctly found page 7's canvas absent.

The smallest repair captures the zoom anchor in the watcher turn, before the
deferred host task can change page geometry, and carries that capture through
coalesced zoom and zoom-mode changes. Wheel gestures retain their already
captured cursor anchor. The coordinator unit contract now proves the capture
happens before the deferred task, while preserving the existing ordering and
gesture assertions. Targeted lint passed, and the coordinator units passed
43/43 on the candidate and 46/46 on integration.

The unchanged page-7 acceptance passed on integration at
`2026-09-06T08-29-24-337Z-3895238-f2c7f739` and on the candidate at
`2026-09-06T08-30-55-538Z-3897496-aa752c72`. Both runs retained the original
blank-frame, canvas-identity, semantic-page, and anchor-drift checks. The
candidate and integration changes are now ready for commit and the affected
regression group. The private book and recording remain on the VPS and were
not uploaded publicly.
### 2026-09-06, split delivery fence and affected-gate follow-up

The affected three-file gate at
`2026-09-06T08-34-08-342Z-3904048-e16cdfa4` failed only in the PDF
split-close case. It recorded four page-change frames, one during split and
three during close, 15 anchor-drift frames, and maximum drift
`0.49979075442575527`; DjVu split-close and the page-7 smoke passed. A
temporary per-frame probe in the coordinator-owned E2E helper showed the
remaining combined-topology run at
`2026-09-06T08-44-08-971Z-3922378-0095119e` still had one page-change frame
and 19 drift frames, but no blank frame. The retained chassis anchor and the
viewport session both remained on page 4. This confirmed a visual delivery
race rather than an obsolete assertion or fixture error. The strict
continuity assertions stayed unchanged.

The smallest product change keeps the workspace split resize fence open for
two visual frames after the Vue split patch, so the second layout and
ResizeObserver delivery can apply the existing semantic anchor before the
settled track is painted. The change is mirrored in candidate and integration
branches in
`app/modules/workspace-shell/composables/useAppShellDirectionalTabs.ts`.
The focused unit checks passed 15/15 in both worktrees and targeted lint
passed in both. The temporary per-frame probe was removed after diagnosis.

A fresh run of the exact affected topology passed all 15 selected tests with
five intentional skips at
`2026-09-06T09-02-39-958Z-3943832-53c18067`, including PDF and DjVu
split-close continuity and the page-7 smoke. Broad regression, exact
large-document acceptance, and integrated-main verification remain required.

CodeRabbit was attempted after this commit. Both review requests ended with
the review WebSocket closing before findings. `coderabbit doctor` passed all
9 checks, including authentication and backend/WebSocket reachability, and a
single retry produced the same close. No review findings were returned, so
this is recorded as a review-service failure rather than an approval.

### 2026-09-06, corrected mixed-size and exact-fixture status

The candidate broad regression at
`2026-09-06T09-13-35-511Z-3977170-a1fd46a8` remains failed. It passed 68 tests
and skipped 18, but timed out in
`viewerSmoke.e2e.test.ts:2730` while fitting an explicitly selected page 2 in
the mixed-size PDF. The assertion still requires the page width to match the
page-track content width within 2 CSS pixels and a rendered canvas. Focused
reproductions passed at
`2026-09-06T09-35-47-335Z-4027766-1b5e2488` and
`2026-09-06T09-36-55-324Z-4029093-9ec337b4`; those runs do not establish a
load cause or close the broad failure. The failure table therefore keeps this
as an unresolved intermittent acceptance failure. The next diagnostic must
capture requested, committed and observed page, fit mode, page and track
widths, and raster readiness from the failed session before another broad run.
No timeout, deadline, or assertion was changed.

The exact local 882-page source was independently verified at
`/home/ubuntu/evb-fixtures/zaliznyak-exact-1660bced.pdf`, 722,178,517 bytes,
SHA-256 `1660bced91f628b9acbb2fc0f9dac29fe783a3f43d26231d8f3b0c73133b21b6`.
The required candidate acceptance gate
`2026-09-06T09-43-22-143Z-4036099-542d315c` admitted that fixture but failed
2/8 tests. The two failures timed out in
`tests/e2e/electron/helpers/viewerAnnotations.ts:979` while waiting for
`textarea.note-window__textarea` after real pointer note placement in
`largePdfAnnotationSave.e2e.test.ts:3294` and `:3660`. The remaining six
tests passed. The captured screenshots show page 1 or page 16 with the note
tool active and no new note editor. A single-test exact reproduction at
`2026-09-06T09-53-32-443Z-4055032-32521550` reproduced the first failure,
passing no tests and skipping the other seven. This is a candidate product or
interaction failure, not a waived baseline issue; root cause and baseline
comparison remain open.

The candidate now contains the published session lifecycle from `d208b880a`
as commit `49c8d588d`. Future Electron runs use its profile-scoped owner
marker, verified process identity, checkpoint-preserving recovery, and normal
runner stop path. The temporary failure-only diagnostic in
`viewerAnnotations.ts` remains uncommitted until the state capture is
complete, then will be removed.

### 2026-09-06, issue #167 VPS-only completion criteria

The live body of [issue #167](https://github.com/evb0110/evb-viewer/issues/167)
was reread after its rewrite. It supersedes the old manual interoperability
brief. Acrobat Reader, macOS Preview, a Mac, owner-created fixtures, human
visual sign-off, and owner review are outside this project and must not block
issue or Project 4 closure. The final report must state the limits of Linux
evidence and must not claim Acrobat or Preview compatibility.

The authoritative #167 acceptance ledger now includes the required committed
`tests/fixtures/electron/interop/` corpus, manifest and README,
`scripts/generate-interop-corpus.mjs`, accurate stock unpatched pdf.js
provenance, explicit synthetic legacy/native/reply/unknown-key cases, all five
canonical kinds, reproducible hashes and qpdf baselines, required missing-
corpus failure behavior, #177 discovery and Rust round-trip coverage, #350
identity and lifecycle reuse, no-op and edited save preservation, real EVB
pointer coverage, qpdf plus an independent Linux renderer, supported encrypted
input save, nonzero scenario counts, validation and review evidence, integrated
main verification, and the reproducible report under
`docs/internal/reliability/issue-167-vps-interop-<date>.md`. Required fixtures may not
be absent or silently skipped. Issue #167 remains open until those checks pass
on the integrated tree.

### 2026-09-06, exact 882-page note-placement diagnosis

The candidate source comparison for the legacy-note path remains green and
unchanged. The Rust reader recognizes `FreeText` plus `Popup` with a blank
appearance as a persisted note, `mapPdfAnnotationParseEntity` preserves the
legacy NM and PDF reference, the application projects a persisted canonical
Text note, and the store-owned mutation path routes deletion and edits without
reintroducing the retired PDF.js editor dependency. The candidate #350 gate
`2026-09-06T09-38-32-773Z-4030766-cc17cea8` passed all four required legacy
identity, sidebar, popup, and neighbor-preservation cases.

The exact 882-page red gate
`2026-09-06T09-43-22-143Z-4036099-542d315c` and focused reproduction
`2026-09-06T09-53-32-443Z-4055032-32521550` failed while creating a new note
with real pointer input. The event trace showed trusted pointerdown and
pointerup events targeting the page canvas even though the ready interactive
annotation layer covered the point. The computed DOM stack contained an empty
full-page SVG surface above the layer. Chromium listed that SVG in
`elementsFromPoint`, but its unpainted background did not provide a native
hit target, so the event fell through to the canvas and the layer's creation
gesture never began. The exact 882 fixture was not modified.

The smallest repair adds a transparent HTML background hit target before the
SVG surface, makes the empty SVG surface non-interactive, and leaves
`.pdf-annotation-editor-entity` nodes interactive for markup and shape
selection. This keeps blank-page placement and existing entity interaction on
the same canonical pointer path. The focused exact case passed without test-
only DOM injection, waits, or diagnostics at
`2026-09-06T10-18-15-332Z-4090655-48d12517`, and the component event unit
suite passed 3/3 under `unit-app`. The helper diagnostics were removed after
the red/green result. The remaining exact-882 cases, the mixed-size broad
failure, exact 2646 acceptance, integrated-main verification, and #167 corpus
acceptance remain open.

### 2026-09-06, mixed-size focused topology follow-up

The unchanged mixed-size page-2 fit predicate passed in a fresh focused run at
`2026-09-06T10-36-04-758Z-4111208-5b9588e2`. A bounded shared-session
reproduction that ran the ten preceding Viewer Smoke cases plus the target
also passed all 11 selected tests at
`2026-09-06T10-37-10-864Z-4112310-c693144f`. This rules out a deterministic
fixture defect and shows that the preceding Viewer Smoke history alone is not
sufficient to reproduce the broad red result. The broad gate
`2026-09-06T09-13-35-511Z-3977170-a1fd46a8` remains failed. Load, cross-file
session history, and geometry timing remain hypotheses, not a disposition.
Temporary failure telemetry was removed after the comparison, and the
page-width, canvas-readiness, and 15-second assertions remain unchanged.

### 2026-09-06, exact 2,646-page acceptance

The candidate xlarge gate
`2026-09-06T10-30-42-864Z-4105416-26c69146` passed both tests in
`xlargeDocumentAcceptance.e2e.test.ts` in 150.07 seconds. It admitted the
required fixture at
`/home/ubuntu/evb-fixtures/zaliznyak-three-distinct-copy-2646-pages.pdf`,
verified 2,646 pages, 2,168,527,413 bytes, and SHA-256
`5609c151c1cec881da4b97ec7028250574f8f0ee67540dcdc8808cc7b8ab0aea`. The
acceptance artifact records path-backed stream staging with equal source and
staged byte counts. The exact 882 and exact 2,646 candidate gates are now
green. Broad mixed-size regression, remaining native and lifecycle coverage,
integrated-main verification, and the rewritten #167 corpus acceptance remain
open.

### 2026-09-06, exact 882-page annotation save acceptance

After the hit-target repair, the full exact 882-page annotation-save gate
`2026-09-06T10-21-24-168Z-4094602-098a72bd` passed all 8/8 tests in
475.54 seconds. It used the required local fixture at
`/home/ubuntu/evb-fixtures/zaliznyak-exact-1660bced.pdf` with 882 pages,
722,178,517 bytes, and SHA-256
`1660bced91f628b9acbb2fc0f9dac29fe783a3f43d26231d8f3b0c73133b21b6`.
The two prior failures, canonical note and text-box edits and sticky-note
reopen after hard restart, both passed without test-only intervention. The
runner stopped the isolated session normally and preserved the gate artifact.
Exact 2,646-page acceptance, the unresolved mixed-size broad failure,
integrated-main verification, and the rewritten #167 corpus acceptance remain
open.

### 2026-09-06, current worker ownership and note-placement readiness correction

The rewritten #167 body is the current completion contract. It removes
Acrobat Reader, macOS Preview, Mac access, owner-created fixtures, human visual
sign-off, and owner review from Project 4 closure. Linux qpdf, independent
rendering, structural checks, real EVB Electron coverage, supported encrypted
input, validation, review, integrated-main verification, and the reproducible
report remain required. The owner will perform visual checks separately, and
that work is not a project checkbox. The private source book and recording were
transferred to this VPS but were not uploaded publicly.

The four coordinated lanes and file ownership are recorded here. Sartre
(`01a0758c-7b63-7592-80c7-392a8027942b`) performed the read-only mixed-size
diagnosis. Its broad red artifact remains
`2026-09-06T09-13-35-511Z-3977170-a1fd46a8`; the focused fresh and bounded
shared-session greens do not prove a load cause. Faraday
(`01a0758c-7c7c-70b3-b9ce-981e68e84d06`) performed the read-only pointer-layer
review. The coordinator owns the shared Electron helpers, runner/configuration,
this ledger, issue and project state, integration, commits, publication,
review scheduling, and final acceptance. Maxwell
(`01a0758c-7e11-7fc2-8645-a58fdcc23a68`) owns the disjoint #167 corpus-prep
files `scripts/generate-interop-corpus.mjs`,
`scripts/verify-interop-corpus.mjs`,
`tests/fixtures/electron/interop/**`, and
`tests/unit/scripts/interopCorpus.test.ts` until review and handoff. Maxwell
must not edit shared helpers, run heavy Electron checks, change refs, or touch
private fixtures. All lanes preserve concurrent edits and report exact red or
green evidence rather than hypotheses.

The scoped background hit target and `v-if` experiment exposed a test
readiness race, not a save or annotation-identity failure. In the clean exact
882 focused red run
`2026-09-06T11-07-56-747Z-4157256-7f4adef7`, the selected page was rendered and
the layer eventually had an interactive background, but immediately before
the real pointer click the point still hit the canvas. The trace showed
`pointermove`, `pointerdown`, `pointerup`, and `click` targeting `CANVAS`.
The smallest justified test correction waits for the exact point to resolve to
the ready interactive background before clicking. It does not change the
10-second editor assertion, use DOM clicks, or weaken the scenario. The focused
red/green pair is `2026-09-06T11-07-56-747Z-4157256-7f4adef7` and
`2026-09-06T11-10-57-695Z-4160871-3b7ac2c4`, where the canonical note/text-box
scenario passed in 29.86 seconds. The temporary event and DOM diagnostics were
removed after the comparison. The full exact 882 acceptance must be rerun on
the final candidate because the earlier 8/8 green preceded these later helper
and CSS changes.

The current #167 corpus-prep handoff contains the two ready PDFs, a manifest,
README, deterministic generator, strict verifier, and unit checks. The
generator labels the pdf-lib dictionary fixture synthetic and labels the
stock `pdfjs-dist-codex-preview` 5.4.296 save as a stock PDF.js output with its
limited provenance. The coordinator must verify that the package is the
unpatched stock writer required by #167, review the five-kind and required-case
inventories, add the real-Electron/native/encrypted acceptance and report, then
run the applicable validation and integration gates. No required corpus may be
silently skipped.

### 2026-09-06, #167 corpus acceptance correction and encrypted proof

The owner-authorized #167 VPS-only scope is now registered as the active
acceptance contract. Linnaeus
(`01a076c6-78f1-78f0-b004-55a9247b5fe6`) completed a read-only corpus audit
without changing files, fixtures, refs or GitHub state. It confirmed the
candidate corpus hashes and provenance, and identified the remaining contract
gaps: required-case flags were not required to be true, Rust discovery still
filtered non-ready entries, no reproducible Linux report existed, and the
Electron corpus test needed broader evidence mapping. No heavy test was
launched by that lane.

The verifier now fails when any required scenario family is absent. The #177
Rust consumer now fails for an absent or empty corpus, non-ready entries,
incomplete required-case declarations, incomplete required-kind declarations,
or missing ready fixture files. The focused native test passed 2/2 at the
candidate after this change. The JS corpus verifier passed with 2 ready
entries, all five canonical kinds, all eight required scenario families and 26
scenarios; its unit suite passed 6/6. `node scripts/generate-interop-corpus.mjs
--check` also passed. The historical optional-discovery wording in closed #177
was clarified by an issue comment to document that #167 closure uses this
strict mode.

The first encrypted Electron attempt timed out because the test waited for a
loaded viewer before driving the password prompt. A focused rerun then exposed
the exact real-pointer hit-test collision: the requested point was covered by
an imported SVG annotation child, while the page background itself was ready
and interactive. The helper now retains real pointer input and chooses a
current point only after hit-testing proves that the ready interactive
background owns it. The encrypted acceptance passed at
`2026-09-06T12-59-56-642Z-92131-4e327902`, including password entry, canonical
import, note creation, unencrypted save, independent render, and password-free
reopen. The earlier timeout and collision artifacts remain recorded as red
diagnostic evidence; neither was waived. The corpus report, final validation,
review, integration and main-tree acceptance remain open.

### 2026-09-06, strict note placement and rendering negative control

The shared `createStickyNoteWithPointer` helper now keeps its default contract
strict at the caller's requested point. If hit-testing does not resolve that
point to the ready interactive background, the helper fails instead of moving
the note to the first rendered page. The only alternate path is an explicit
`allowClearPointSearch` option, which requires a numeric target page and scans
that page's own container. The encrypted #167 test uses that opt-in for page 1
and asserts that the new canonical note has page 1 identity, positive geometry,
and bounds inside that page.

The focused rerun passed both #167 Electron tests in
`2026-09-06T13-18-58-910Z-119682-d91f3963` with the named session lifecycle;
the outer heavy-gate evidence is
`2026-09-06T13-18-57-577Z-119652-d6b2f3bf.ndjson`. It covered corpus import,
text edit, save, two fresh-copy reopens, encrypted password entry, real-pointer
note creation, unencrypted save, independent rendering, qpdf's
`File is not encrypted` output, and password-free reopen. The prior green at
`2026-09-06T12-59-56-642Z-92131-4e327902` is retained as history, not used as
the final result.

`verify-interop-rendering.mjs` now renders each controlled fixture twice with
Poppler: normal and `-hide-annotations`. Each selected text-box, highlight,
native Text note, stamp, and Square crop must be non-white in the normal image,
white in the hidden-annotation control, and differ by at least 1,024 mean
levels. The final synthetic/stock evidence is retained at
`.devkit/artifacts/issue-167-interop-negative-control`; hidden crops were
`65535`, with normal-to-hidden deltas of 3,590.1, 11,822, 13,838.5, 35,037.7,
and 5,840.9 respectively. Poppler reported its expected blank-legacy-AP
warning. The renderer versions and exact commands are recorded in the JSON
result. The focused corpus unit suite passed 7/7, the generator check and
strict verifier passed, targeted lint passed, and tests/scripts typecheck
passed. Exact large-fixture evidence and the mixed-size broad red remain open.

### 2026-09-06, final candidate acceptance evidence and live-run correction

The current candidate reran the required large fixtures after the strict note
placement and renderer negative-control changes. The exact 882-page matrix
passed 2/2 in
`2026-09-06T13-29-03-256Z-133454-a5905ec9` using the required
`1660bced...` fixture. The exact 2,646-page acceptance passed 2/2 in
`2026-09-06T13-34-08-713Z-138382-9b88235f` using the required
`5609c151...` fixture. The required-fixture #350 gate passed 4/4 in
`2026-09-06T13-23-39-763Z-127335-2b23fb2a`. The lifecycle and stamp gate
passed 8 tests, with 9 historical cases explicitly skipped, in
`2026-09-06T13-25-11-224Z-129085-ddb4a7b4`. Skipped cases are not counted as
acceptance evidence.

The broad mixed-size gate remains red at
`2026-09-06T09-13-35-511Z-3977170-a1fd46a8`. Its retained failure artifact
identifies the page-2 fit-width test and captures a screenshot with toolbar
state `2 / 4` at `158%`, page 2 selected, a wide page track and page 3 visible
below. The artifact and session-combined log do not retain the serialized
`pageOneSnapshot` or `pageTwoSnapshot`, page-track width, or raster-readiness
values from the thrown assertion. The session logs do show the four-page
fixture and page-2 transition reached the renderer, but that is not enough to
classify the failure as load, shared-session history, or geometry timing. The
focused predicate and the ten-predecessor shared-session reproduction both
passed at `2026-09-06T10-36-04-758Z-4111208-5b9588e2` and
`2026-09-06T10-37-10-864Z-4112310-c693144f`; those greens show
intermittency, not a disposition. No timeout or assertion was widened.

The broad gate's Electron session stopped through the normal lifecycle at
09:18:33 UTC, while its outer validation process remained resident until the
coordinator rechecked it after the later exact runs. It then exited without
intervention. There is no live heavy process at this checkpoint. This corrects
the earlier stale `Live heavy run: none` entry without deleting the historical
red evidence.

### 2026-09-06, native parallel lanes and validation correction

The coordinator used three native Luna lanes in this worktree and closed them
after their bounded reports. Tesla verified the interop coverage correction in
`tests/unit/scripts/interopCorpus.test.ts`: the focused unit run passed 7/7,
and the coverage summary recorded 72/101 lines for
`scripts/generate-interop-corpus.mjs` and 79/113 lines for
`scripts/verify-interop-rendering.mjs`. The lane found no justified remaining
coverage gap and changed no files. Locke wrote only the ignored
`.devkit/issue-168-prep/README.md` preparation artifact. It verifies the
current `pdfjs-dist` 5.7.304 provenance and records the unverified 6.x target
receipt, API differences, and ordered migration plan. Anscombe inspected the
retained mixed-size broad red and supplied one diagnostic replay topology with
the state predicates needed to distinguish raster scheduling, geometry timing,
and shared-session history. It did not launch Electron or edit files.

The required validation run at
`.devkit/gates/2026-09-06T143553Z/01-validate.log` completed all other stages,
including full coverage and blocking Electron smoke, but failed `typecheck.full`
on the missing `inputPaths` property in the new renderer-oracle unit call. The
coordinator added the typed `inputPaths: []` property. The focused interop
unit run passed 7/7 and the tests/scripts typecheck passed afterward. The full
required validation must be rerun on this fixed tree before publication.

### 2026-09-06, mixed-size fit-width race repaired

The broad red at
`2026-09-06T09-13-35-511Z-3977170-a1fd46a8` is retained as a failed historical
gate. A stack-captured focused reproduction identified the product race. A
page-specific fit calculation for the pending page-2 navigation was followed
by `ResizeObserver.handleResize` calling `computeFitWidthScale` without a page,
which selected current page 1 while page 2 was still pending. The resulting
scale could rebuild page 1 geometry over the page-2 transition. The same race
was also possible in the deferred workspace fit handoff.

The coordinator repaired this by passing the trusted resize anchor page in
`app/modules/pdf-viewer/runtime/composables/usePdfViewerResizeLifecycle.ts`,
and by carrying the captured semantic page through
`useWorkspaceViewState`, `usePdfViewerFitWidthController`, and the viewer
expose contract. The focused unit set passed 40/40, including the pending-page
resize assertion. The focused Electron reproduction passed 1/1 at
`2026-09-06T15-46-12-173Z-544080-0776c576`, and the ten-predecessor topology
passed 10/10 at `2026-09-06T15-48-50-806Z-546810-1e84ec9c`. The source
instrumentation was removed after the caller was identified. Final broad and
large-fixture acceptance remains required after the candidate settles. The
separate crop-overlay failure from the broad gate has no evidence of sharing
this cause and remains open.

### 2026-09-06, split close continuity ordering repair

The split close continuity probe reproduced the remaining race twice after the
fit-width repair. The red artifacts were
`2026-09-06T17-01-25-610Z-654516-76c5b088.ndjson` and
`2026-09-06T17-05-49-572Z-658917-76c5b088.ndjson`. The first recorded 17
wrong-page frames, all 16 close-phase frames after the split, with no blank
frames. At the first mismatch, page 3 still had its old 565 by 731 rendered
canvas while page 4 had a 126 by 163 placeholder. The chassis still carried
requested, committed, and resize-anchor page 4. The second run kept page 4
stable but recorded one anchor-drift frame, so the failure was intermittent,
not a missing-document or disconnected-pane case.

The render trace tied the ordering to `usePdfViewerResizeLifecycle`: the
preview scale ref changed, `restoreResizeAnchorAfterLayout` submitted the
asynchronous viewport-authority intent in the same turn, and the authority
could resolve against the preceding page-track geometry. Vue then committed
the preview scale, the visible range reprojected, and page 4's replacement
raster was delayed or cancelled. The smallest repair keeps the immediate
semantic preview, waits for the existing `nextTick` geometry commit, reapplies
the preview, and only then submits the authority intent. It fail-closes if the
viewer becomes inactive, starts loading, or loses its document during that
flush. No timeout or continuity assertion changed.

The resize lifecycle unit file passed 20/20 after its ordering assertions were
updated. The affected app unit set passed 89/89. The same real-pointer split
close topology passed with diagnostics enabled at
`2026-09-06T17-16-45-309Z-673973-26a0a8bf.ndjson`, then passed again with all
temporary trace and page-sample plumbing removed at
`2026-09-06T17-19-28-526Z-678452-6cb01436.ndjson`. The broad historical
mixed-size failure and the separate crop-overlay failure remain recorded and
still require their own final disposition.

### 2026-09-06, required validation green after admission and type fixes

The coordinator first ran the focused native-page-ops admission unit file,
which passed 4/4, the targeted lint lane, and the full repository typecheck.
The smallest type fix added the documented `project` option to
`scripts/assert-electron-native-page-ops.mjs`; it did not alter admission
behavior. The canonical headless launcher continued to set
`EVB_PDF_PAGE_OPS_ENABLE=1` for native-required projects and to admit explicit
native-disabled negative tests.

The required validation then passed in
`.devkit/gates/2026-09-06T173538Z/01-validate.log`, with summary
`.devkit/gates/2026-09-06T173538Z/summary.json` and consolidated evidence
`.devkit/analysis/gates/2026-09-06T17-35-38-877Z-724069-30da07f7.ndjson`.
It recorded 1,276 passing test files, 10,806 passing tests, 8 skipped tests,
and one skipped file. Lint, typecheck, the coverage ratchet, the
zero-execution tripwire, native tests, the all-platform resource matrix,
strict build, Electron bundle integrity, and blocking Electron smoke all
passed. The smoke ran through the native admission launcher and reported two
passing tests and one skipped test. The earlier failed validation and the
unconfigured 14:56 broad regression remain historical red artifacts. Neither
is waived, and neither replaces the correctly configured final acceptance
queue.

### 2026-09-06, final candidate acceptance after green validation

The final candidate reran the required acceptance after the green validation
gate. The private #350 fixtures were rehashed before the run. The #350 gate
passed 4/4 at
`.devkit/analysis/gates/2026-09-06T17-47-42-656Z-764581-4f680ff6.ndjson`.
It covered the legacy identity through pointer selection, sidebar and popup
deletion, edit migration, save and reopen, reply and Popup cleanup, and
neighbor preservation. The minimal source remained 3,153 bytes with SHA-256
`f6f4a9800e5cd65891b57136000e59f083fb0a91aa2fe2ee4811903e60a130da`.

The exact 882-page annotation-save lane passed 8/8 in
`.devkit/analysis/gates/2026-09-06T17-50-28-015Z-768152-47f266e1.ndjson`.
It admitted `/home/ubuntu/evb-fixtures/zaliznyak-exact-1660bced.pdf`,
722,178,517 bytes, SHA-256
`1660bced91f628b9acbb2fc0f9dac29fe783a3f43d26231d8f3b0c73133b21b6`, and
completed imported Text/Popup, markup edit, moved sticky-note, canonical
note/text-box, hard-restart, FreeText continuity, create/reopen, and
delete/restart cases. The exact 2,646-page lane passed 2/2 in
`.devkit/analysis/gates/2026-09-06T17-59-21-375Z-780331-bc823f92.ndjson`.
It admitted `/home/ubuntu/evb-fixtures/zaliznyak-three-distinct-copy-2646-pages.pdf`,
2,168,527,413 bytes, SHA-256
`5609c151c1cec881da4b97ec7028250574f8f0ee67540dcdc8808cc7b8ab0aea`.

The correctly configured broad Viewer Smoke gate passed 24/24 in
`.devkit/analysis/gates/2026-09-06T18-02-34-043Z-784584-3bda45c5.ndjson`.
It passed the repaired mixed-size fit assertion, crop and screenshot overlay,
PNG entry, all exercised DjVu opening/sidebar/viewport/navigation and split
continuity cases, and the pressure cases. The historical broad red remains a
failed record, but its missing native capability flag explains its annotation
and markup failures, while the repaired fit-width and split ordering cases
passed under the canonical launcher. One PNG sub-session hit the graceful-stop
deadline and used the documented process-tree fallback; its test passed, the
session was stopped, and no candidate Electron process survived. This is an
infrastructure warning to retain for lifecycle review, not an acceptance
assertion failure.

The local CodeRabbit attempt was made against `main` with the complete dirty
candidate scope after validation. The service closed its WebSocket before
returning a review. `coderabbit doctor` then passed all 9 checks, including
authentication and backend/WebSocket reachability, but no finding stream was
returned. No paid continuation or repeated review attempt was made. This is a
documented review-service fail-open condition after the required validation and
acceptance gates passed; it remains visible for publication and integration
review.

### 2026-09-06, final #167 candidate evidence before publication

The corpus reproducibility check and strict corpus verifier passed with two
ready entries, all five canonical kinds, all eight required scenario families,
26 scenarios, and one stock unpatched `pdfjs-dist-codex-preview` writer entry.
The independent Linux renderer retained normal and `-hide-annotations`
renders in `.devkit/artifacts/issue-167-interop-negative-control-final`.
qpdf and Poppler checks passed, and every selected annotation crop had a
positive hidden-minus-normal paint delta while the hidden crop was white.

The fresh real-Electron #167 acceptance passed 2/2 in
`.devkit/analysis/gates/2026-09-06T18-18-14-963Z-812978-fc5a8a7c.ndjson`.
It covered corpus import, text-box edit and save, two reopen cycles, generated
encrypted input, password-free save, independent rendering, and reopening the
saved output. The named Electron session stopped normally. This evidence is
candidate-only until integrated-main verification passes.

### 2026-09-07, migrated-tree validation correction

The corrected canonical validate run at `.devkit/gates/2026-09-07T025807Z`
tested candidate base `72f411b388026348b4f1619f649d3fecd2b1e2c2` plus the
frozen dirty PDF.js 6.3.311 migration tree. It finished at
`2026-09-07T03:10:18Z` with exit 1 after exercising 1,305 test files and
11,057 tests. The first attempt at `.devkit/gates/2026-09-07T025704Z` failed
before tests because its shell could not find nvm `pnpm`; that environment
failure is separate from the four validation reds below.

Halley's read-only Fallow review confirmed a real migration duplicate in the
browser search and image-export loaders. The coordinator extracted
`app/platform/browser-api/loadBrowserPdfjsDocument.ts`, preserving the
range-read rejection race, PDF.js compatibility adaptation, loading-task
destruction, and rejecter cleanup. The duplicate regression check passed.

Pasteur's read-only image-export review confirmed that PDF.js 6.3 adaptation
correctly wraps `getPage`; three assertions were stale because they inspected
the replaced property instead of the original Vitest spy. The tests now retain
the original spy before adaptation. The focused image-export file passed 19/19.

The renderer link-geometry test intentionally adds two `as never` typed-boundary
assertions. Its baseline was updated from 13 to 15, and the tests-as-never
ratchet passed with 380 assertions in 94 files. Pauli's read-only CSS review
confirmed that `#pdfjsFillableField` is valid upstream PDF.js v6 SVG fragment
syntax and that postcss-svgo emits a harmless parser warning. A narrow,
test-backed warning allowlist entry matches only this Vite/SVGO warning and
fragment. The warning checker passed 14/14, and the real build log is accepted
as five known warnings.

The migrated-tree focused repair set is green: typecheck, targeted ESLint,
Fallow duplicate regression, diff check, browser search and search capability,
image export, PDF.js compatibility, renderer link geometry, and build-warning
policy. No heavy or Electron gate is active. The next canonical validate run
must be performed after this focused repair set, then all post-migration
acceptance and integrated-main evidence remains required.

The follow-up canonical validate gate at `.devkit/gates/2026-09-07T032355Z`
finished at `2026-09-07T03:38:04Z` with exit 1. Coverage, type coverage, strict
build, native tests, Fallow, warning policy, tests-as-never, and zero-execution
coverage passed. It left only full ESLint and the stale bundle-integrity
expectation red. After the gate became terminal, the coordinator corrected
those two issues and verified targeted ESLint, bundle integrity 58/58,
tests-as-never, typecheck, Fallow duplication, and diff check. The next full
validation is therefore justified and must run against the unchanged repaired
tree.

The repaired canonical validation ran at `.devkit/gates/2026-09-07T034313Z`
with coordinator session `49820` and finished at `2026-09-07T03:55:42Z` with
exit 0. It passed the full selected validation set, including 1,304 test files
with one skipped, 11,050 tests with eight skipped, coverage ratchet,
zero-execution coverage for 672 production files including 492 changed files,
native/resource checks, strict build, bundle integrity, and blocking Electron
smoke. The smoke log also contains a refused probe to `127.0.0.1:3000` while
the isolated Nuxt session was using port `38209`; the selected smoke tests
still passed and the parent gate recorded success. This diagnostic is retained
for runner follow-up, not treated as a product acceptance failure.

The first post-migration #350 attempt at
`.devkit/analysis/gates/2026-09-07T03-57-32-789Z-2267341-5bd56cf0.ndjson`
correctly skipped because its optional fixture overrides were not supplied.
The corrected run supplied both private paths and required variables, rehashed
the source inputs, and passed all four cases in
`.devkit/analysis/gates/2026-09-07T03-58-35-246Z-2270488-8c317f1e.ndjson`.
It covered legacy identity through pointer selection and deletion, edit
migration, reported-file deletion and reload, popup/reply cleanup, and
neighbor preservation. The source fixtures remained unchanged.

The post-migration #167 interoperability gate passed both tests in
`.devkit/analysis/gates/2026-09-07T04-00-44-577Z-2274873-dca032c3.ndjson`.
It imported the five-kind corpus, edited and saved a text box, independently
rendered the output, reopened two fresh copies, then opened the supported
encrypted input, created a note with real pointer input, saved a password-free
output, independently rendered it, and reopened it. The corpus and private
fixtures were copied into run-owned temporary directories and left unchanged.

The post-migration annotation lifecycle slice passed 7 tests and intentionally
skipped 9 historical cases in
`.devkit/analysis/gates/2026-09-07T04-02-19-833Z-2277317-5c9acf08.ndjson`.
The passing cases covered canonical renderer ownership, keyboard editing and
mixed history, stamps, sidebar projection, empty and edited sticky notes, and
foreign replies. The skipped cases remain explicit and are not counted as
acceptance evidence.

The full post-migration Viewer Smoke gate passed 25/25 in
`.devkit/analysis/gates/2026-09-07T04-05-07-331Z-2282229-284e5396.ndjson`.
It covered PDF and DjVu viewport continuity, mixed-size fitting, split-divider
anchors, crop and screenshot overlays, pressure scrolling, PNG entry, native
DjVu search, continuous and projected scrolling, fit-height navigation, and
high-zoom residency. The PNG child session used the documented process-tree
fallback after its graceful controller deadline; its assertion passed and no
candidate session remained.

The post-migration save-pipeline gate passed 5 exercised tests with one
intentional skip in
`.devkit/analysis/gates/2026-09-07T04-16-39-476Z-2303270-a891f57a.ndjson`.
It covered encrypted-save warning and suppression, Optimize As Copy, receipt
reuse and same-size drift rejection, and hard-stop cleanup followed by reopen.

The first exact 882 launch failed before collection because it omitted
`EVB_EXACT_FIXTURE_PROFILE`; the admission artifact is
`.devkit/analysis/gates/2026-09-07T04-24-02-385Z-2315122-6df9ac20.ndjson`.
The corrected run set `localZaliznyak882`, rechecked the required
722,178,517-byte source and SHA-256
`1660bced91f628b9acbb2fc0f9dac29fe783a3f43d26231d8f3b0c73133b21b6`, and
passed all 8/8 exact-fixture tests in
`.devkit/analysis/gates/2026-09-07T04-24-56-879Z-2316845-c5cb5b51.ndjson`.
It covered imported Text/Popup and markup persistence, moved sticky notes,
multiple canonical edits, hard restarts, ordinary FreeText visibility and
creation, and persisted FreeText deletion.

The post-migration exact 2,646-page acceptance set
`EVB_EXACT_FIXTURE_PROFILE=xlargeZaliznyak2646` and passed 2/2 in
`.devkit/analysis/gates/2026-09-07T04-34-49-553Z-2333337-7e1132ef.ndjson`.
It used the required 2,168,527,413-byte source with SHA-256
`5609c151c1cec881da4b97ec7028250574f8f0ee67540dcdc8808cc7b8ab0aea` and
covered two-session reopen plus fresh-renderer save/reopen. Both source files
were hash-checked before launch and left unchanged.

The exact 882 native annotation matrix then passed 2/2 in
`.devkit/analysis/gates/2026-09-07T04-39-38-387Z-2340429-8e89dfeb.ndjson`.
It used the required 722,178,517-byte source and SHA-256
`1660bced91f628b9acbb2fc0f9dac29fe783a3f43d26231d8f3b0c73133b21b6` and
covered canonical annotation create, update, delete, recreate, save, and hard
reopen, plus placed-image move, delete, save, and hard reopen. The source was
hash-checked before launch and left unchanged.

The exact 882 native preview gate passed 3/3 in
`.devkit/analysis/gates/2026-09-07T04-47-23-367Z-2349493-e86c08d3.ndjson`.
It covered the generated native first-paint handoff, early-close cleanup, and
the exact 882 production dictionary without a navigation flash. The named
session stopped normally and no candidate Electron process remained.

The native split-pane lifecycle gate passed 1/1 in
`.devkit/analysis/gates/2026-09-07T04-50-44-688Z-2354021-c1c6226c.ndjson`.
It used the generated two-page native fixture and verified four independent
same-path panes after the PDF.js handoff, including distinct working-copy
paths and stable page-one toolbar state. The named session stopped normally.

The draw-shapes gate passed 17/17 in
`.devkit/analysis/gates/2026-09-07T04-53-07-000Z-2356953-5d581b3f.ndjson`.
It covered all 16 draw lifecycle cases and the Electron/Playwright stroke
parity case. The parity telemetry showed one managed shape and equal metrics in
both runtimes, with zero crop pixels in both measurements. That telemetry is
retained as a review note and is not being used as independent annotation-paint
proof.

The final CodeRabbit attempt on the complete migrated candidate reached the
review service but ended with `WebSocket closed`. `coderabbit doctor` had
already passed all nine local checks during the earlier review attempt, so no
paid continuation or repeated retry was made. This is a provider fail-open
result after the green canonical validation and acceptance gates, not an
approval or a clean review result.
