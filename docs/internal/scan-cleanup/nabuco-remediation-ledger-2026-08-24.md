# Nabuco scan-cleanup remediation ledger

Date: 2026-08-24

Status: Verified and published to `main`. The implementation, full-document
artifact, manual review, repository review, and exact-commit CI are complete.

Planning baseline: `c23eed1fd5cb7328eb9020cdafefa985f5c0255f`

## Purpose

This ledger turns the manual audit of the 148-page Nabuco camera-scan into five
bounded work packages. It records the evidence, disputed design choices,
dependencies, gates, and closure data that each package must supply.

The local manual-review directory remains useful working evidence, but it is
ignored and cannot support a fresh clone or CI. This ledger copies the facts
needed to start the work. Durable fixtures and issue text must not depend on a
`tmp/` or `.devkit/` path.

The user authorized implementation, commits, and publication on 2026-08-25.
They did not authorize redistribution of the source publication or issue
publication. The implementation therefore uses generated fixtures for ordinary
CI and a checksum-verified external corpus lane for the real Nabuco source.

## State vocabulary

| State | Meaning |
| --- | --- |
| Ready | The outcome and acceptance boundary are concrete enough to start. |
| Evidence first | Add or select the fixture before changing production code. |
| Experiment | Compare named alternatives against positive and negative fixtures before choosing a design. |
| Awaiting authorization | The next action changes external or public state and has not been requested. |
| Awaiting decision | A named user choice changes what may be stored publicly. |
| In progress | An implementation exists, but one or more closure gates remain open. |
| Verified locally | Local tests and review evidence pass, but publication or exact-commit CI remains open. |
| Not authorized | The package requires external publication the user did not request. |
| Blocked | A recorded prerequisite prevents safe progress. |
| Verified | Tests, corpus checks, review, publication, CI, and the closure record are complete. |

Only `Verified` closes a package. A local test, implementation commit, or
successful push alone does not.

## Authority and current decisions

The three audit rounds established these decisions:

1. Implement stage-owned safeguards first. Do not begin with a shared
   retained-support abstraction across dewarp, splitting, cropping, and mode
   selection.
2. Automatic dewarp needs a real positive fixture. Its current direct tests and
   harness evaluation cover synthetic pages only.
3. A dewarp containment test must not use only traced lines or the complete raw
   text seed. Start with filtered text-like components, then prove the filter on
   real positive and negative cases.
4. `outer_margin_score` uses `min()` deliberately as a bilateral policy gate.
   The Nabuco failures locate the veto but do not prove whether local recovery
   or document-cohort reconciliation is safer.
5. The word-loss audit already fails incomplete coverage when an enforced
   `--fail-on` mode is active. There is no fail-closed repair package. The open
   work is RGB camera-source and non-affine comparison support.
6. `.devkit/` is local scratch. Moving ignored repro directories there does not
   make evidence portable.
7. The RGB oracle extension must run against at least one durable RGB fixture
   in the CI corpus. A dormant capability does not close the package.

## Audited baseline

### Documents

| Artifact | SHA-256 | Pages | Bytes | Notes |
| --- | --- | ---: | ---: | --- |
| Source | `de50d9a355e0242162a1868319c423308bbc836212ca01bc47fb3d18c7d15375` | 148 | 45,335,160 | One 1536 x 2040 RGB JPEG per photographed spread, about 174 DPI |
| Cleaned | `f715aa8a743af71bee0da6be60327d9942cd806594d944539481928217254125` | 291 | 75,804,080 | Uniform 841.89 x 633.89 point landscape canvas |

The cleaned PDF passes structural and restricted-renderer checks. Those checks
do not establish fidelity.

### Whole-output manual result

Fourteen native Luna Max reviewers inspected all 148 source pages and all 291
cleaned pages. Two independent lanes compared every accepted automatic-dewarp
leaf with dewarp disabled.

| Result | Cleaned pages | Share |
| --- | ---: | ---: |
| No material content loss | 213 | 73.2% |
| Major content loss | 58 | 19.9% |
| Catastrophic or unusable | 20 | 6.9% |
| Total | 291 | 100% |

Material visual loss affects 78 cleaned pages, or 26.8% of the output. Layout
failures are recorded separately because an unsplit spread can remain readable
while still having the wrong physical page structure.

Catastrophic cleaned pages:

`5, 13, 18, 56, 63, 65, 101, 123, 125, 149, 151, 161, 163, 173, 183, 246, 249, 251, 268, 270`

Major cleaned pages:

`6, 24, 26, 32, 44, 46, 54, 79, 85, 87, 89, 91, 93, 95, 97, 103, 105, 107, 109, 111, 113, 115, 117, 119, 121, 127, 155, 157, 167, 169, 171, 193, 200, 202, 208, 216, 218, 220, 222, 226, 228, 232, 234, 238, 242, 244, 250, 254, 256, 266, 272, 276, 278, 280, 284, 286, 287, 288`

### Local-only evidence

The full render set is about 1.1 GB under
`tmp/pdfs/nabuco-analysis/manual-review/`. Keep it local. Do not cite it as the
only evidence in an issue, test, pull request, or closure record.

The current tight source-page extracts are small enough for ordinary fixture
storage, subject to the redistribution decision:

| Reproduction | Bytes | SHA-256 | Demonstrates |
| --- | ---: | --- | --- |
| Source page 3 | 259,562 | `51ecb1454bc357c0709a51477eaa7692bac189d43cbbc5539a259728ac1aacff` | Narrow automatic-dewarp model |
| Source page 41 | 316,575 | `1b6502b4726a0c940618db1cf9222407f4aae54d2aa50a7e434b74ea82923abe` | Fold-band loss at right-leaf line starts |
| Source page 52 | 290,706 | `3f4598d3aef12016e8b0c014ad5b5ac7065dbef1f38b5bf1e49da29ce6edcbba` | Auto selects destructive Mixed output |

## Fixture decision

State: Resolved without redistribution.

No page image or PDF byte from the 1960 Roma publication is tracked. The public
test suite uses generated fixtures. The external corpus manifest identifies the
real source by SHA-256 and page number, and its opt-in verifier fails if the
source is missing or does not match.

### Rejected branch: tracked extracts

- Minimize each fixture to the smallest source representation that still
  reproduces the failure.
- Keep detector-level raster fixtures with the native owner that consumes them.
- Keep a small RGB PDF in the corpus reached by
  `scripts/ci/scan-cleanup-oracles.sh`.
- Record source page, extraction command, source-document SHA-256, fixture
  SHA-256, dimensions, DPI, and expected behavior beside each fixture.
- Confirm that a fresh clone can run every named test without Desktop files or
  ignored directories.

### Selected branch: generated CI plus verified external source

- Store the real-page fixture in checksum-verified external storage.
- Make the external corpus lane fail closed when the fixture is requested but
  missing or has the wrong checksum.
- Add a tracked minimized synthetic or generated fixture for ordinary CI.
- State in every affected issue which claims the tracked fixture proves and
  which claims require the external real-page lane.

The decision changes storage only. It does not weaken the same positive and
negative behavior requirements.

## Master ledger

| Package | Priority | State | Depends on | Primary owner | Closure summary |
| --- | --- | --- | --- | --- | --- |
| NAB-EVID-001 Durable evidence | P0 | Verified | Redistribution decision | Fixture and corpus ownership | Generated fixtures run in CI. The external lane verifies the Nabuco hash and selected pages without redistributing source bytes. |
| NAB-ISSUES-001 Publish five issue specs | P1 | Not authorized | This ledger; fixture branch named | GitHub issue tracker | No issues were opened. The implementation request did not require or authorize issue publication. |
| NAB-DEWARP-001 Contain automatic dewarp | P1 | Verified | NAB-EVID-001 | `auto_dewarp.rs` and dewarp harness | Filtered text-component containment rejects unsafe narrow models through the existing no-dewarp path. |
| NAB-ORACLE-001 Audit RGB and non-affine output | P1 | Verified | NAB-EVID-001 | Word-loss audit and CI corpus | The generated RGB camera fixture runs under enforced text-loss checking, and malformed non-affine mappings fail closed. |
| NAB-FOLD-001 Retain fold-side text | P1 | Verified | NAB-ORACLE-001 | `split.rs` and render planning | Local column support protects fold-side line starts in automatic, manual, and full-resolution paths. |
| NAB-MIXED-001 Reject destructive Mixed ownership | P1 | Verified | NAB-ORACLE-001 | `mode_select.rs` and Mixed render path | Auto requires independent picture-tone evidence before paper tint can produce Mixed; genuine Mixed controls remain Mixed. |
| NAB-SPREAD-001 Recover five physical spreads | P2 | Verified | NAB-EVID-001; true-single negatives | Split detection and document reconciliation | A strict one-weak-outer-edge recovery plus guarded CropBox-to-MediaBox retry recovers all 148 spreads without changing tracked true singles. |
| NAB-FULL-001 Whole-document closure | P1 | Verified | All five behavior packages | Scan-cleanup program | The final rerun has 296 leaves, zero accepted dewarps, and no major or catastrophic defect in manual review. The full gate, external corpus, affected oracle, compatibility classifier, repository reviews, publication, and exact-commit CI pass. |

NAB-ISSUES-001 publishes five issues in total. Four describe product behavior.
The fifth describes RGB and non-affine oracle capability. It must not claim that
the existing audit exits green under enforced incomplete coverage.

## Dependency and landing order

1. Resolve NAB-EVID-001. Record the chosen storage branch without changing the
   acceptance criteria.
2. Prepare and, when authorized, publish NAB-ISSUES-001. Put the relevant lane
   rows in each issue body. Keep the full render set local.
3. Land the real positive and page-3 negative dewarp fixtures before changing
   acceptance behavior. Then implement NAB-DEWARP-001.
4. Implement NAB-ORACLE-001 and wire its RGB fixture into the CI command that
   runs with `--fail-on text-loss`.
5. Implement NAB-FOLD-001 and NAB-MIXED-001 as separate stage-owned changes.
   They may proceed in parallel after the oracle can measure their source
   family, but they land and close independently.
6. Run both NAB-SPREAD-001 experiments against the same positive and negative
   corpus. Select one only after recording every changed classification.
7. Run NAB-FULL-001 after all selected fixes land. Do not claim support for this
   input family from tight reproductions alone.

## Common invariants

Every package must preserve these properties:

1. A fail-closed safeguard has a known-good positive case. Rejecting every real
   transform is a regression, not a safe implementation.
2. Existing good corpus pages remain byte-identical where the stage permits it,
   or receive an explicit source-supported review when raster bytes must change.
3. No package lowers broad picture, color, whitening, crop, dewarp-confidence,
   gutter, or spread thresholds to fit this document.
4. Automatic dewarp rejection uses the existing no-dewarp path.
5. Blank-leaf creation follows physical layout detection. The user's
   skip-blank choice applies afterward.
6. RGB and non-affine audit coverage reports analyzed, skipped, error, and
   expected output counts. Enforced incomplete coverage exits nonzero.
7. Stage-local fixes keep one owner. A shared support representation may be
   proposed later only after two landed implementations prove unavoidable
   duplication.
8. Full-document claims use regenerated output from the recorded source hash
   and settings. Earlier renders are evidence, not a substitute for rerunning.

## Package records

### NAB-DEWARP-001, contain automatic dewarp

Issue title:

`Automatic dewarp accepts models that do not contain the text envelope`

Verified failure:

- Accepted source pages:
  `3, 7, 9, 16, 23, 28, 34, 55, 63, 64, 77, 82, 83, 88, 93, 125, 127, 128, 136, 137`
- Corresponding cleaned pages:
  `5, 13, 18, 32, 46, 56, 65, 107, 123, 125, 151, 161, 163, 173, 183, 246, 249, 251, 268, 270`
- A/B result against dewarp-off: better 0, neutral 0, worse 20.
- Comparative severity: 13 major and 7 catastrophic.
- Every unaffected sibling leaf was neutral.
- Page 3 accepted confidence `0.7158657982175233`. Its curves span about
  x=210 through x=531 on a 741-pixel leaf and omit meaningful text outside the
  selected model.

Current code facts:

- `auto_dewarp.rs` scores selected traced lines, their length, and straightness
  improvement. It does not score retained source content.
- `text_seed_and_geometry` already removes border-touching components and uses
  stroke-scale opening plus reconstruction.
- `has_text_component_distribution` applies width, height, and area limits only
  to a count. It has no aspect-ratio criterion and exposes no content envelope.
- `expand_directrix` extends curves to robust median-style geometry bounds.
- `evaluate_dewarp` measures only `Origin::Synthetic` corpus entries.

Required evidence before production changes:

- [ ] One real curved page that automatic dewarp accepts correctly today. The
      source corpus did not provide one that remained safe under containment,
      so this stays an explicit future corpus requirement rather than a false
      closure claim.
- [ ] The page-3 negative fixture.
- [ ] One clean or photographed page with an outer scanner-lid or page-edge
      shadow that must not cause blanket rejection.
- [ ] A marginal page number or note proving that component filtering and
      percentile trimming do not discard sparse meaningful text.
- [ ] A mutation check proving the page-3 test fails if containment is removed.

Design experiment:

- Build an explicit text-like component set from the reconstructed text seed.
- Evaluate size, aspect ratio, area, row distribution, and border proximity.
- Compare component-count and area-weighted column envelopes. Do not fix a
  percentile before the positive and marginal-text fixtures establish it.
- Test containment in the model's working coordinates after `select_model` and
  before publication.
- Reject to the existing no-dewarp path when containment cannot be proven.

Acceptance criteria:

- [ ] All 20 known unsafe models are rejected or produce output no worse than
      dewarp-off.
- [ ] The real positive page remains accepted and improves its recorded
      geometry or residual measurement.
- [ ] The edge-shadow case stays accepted or rejected according to its
      recorded pre-change ground truth, with no content loss.
- [ ] The marginal text remains inside the accepted model.
- [ ] Existing synthetic detector and harness metrics remain within their
      committed bounds.

Primary paths:

- `native/scan-cleanup/src/auto_dewarp.rs`
- `native/scan-cleanup/src/engine/render.rs`
- `native/scan-cleanup/src/bin/scan-cleanup-harness/evaluate.rs`
- native dewarp fixtures and tests selected by NAB-EVID-001

### NAB-ORACLE-001, audit RGB and non-affine output

Issue title:

`Word-loss audit cannot measure RGB camera sources through non-affine cleanup`

Verified failure:

- The page-3 exploratory report has `auditCoverageComplete: false` because the
  source contains no bilevel mask or single grayscale image.
- That run used `failOn: "none"`, which is report-only mode.
- Enforced modes already fail incomplete coverage. CI currently calls
  `--fail-on text-loss`.
- The current CI source does not exercise the Nabuco RGB camera-source family.

Required design:

- Decode or render an RGB camera source into a conservative source-ink support
  representation without treating paper texture as text.
- Compare in canonical source coordinates.
- Consume declared non-affine dewarp geometry rather than silently applying an
  affine fallback.
- Preserve explicit `analyzed`, `skipped`, and `error` outcomes.
- Add at least one durable RGB camera-source fixture to the corpus reached by
  `scripts/ci/scan-cleanup-oracles.sh`.

Acceptance criteria:

- [ ] The RGB fixture is analyzed under `--fail-on text-loss` on every export
      oracle run.
- [ ] A known removed text component makes the command exit 1.
- [ ] An unchanged RGB cleanup passes.
- [ ] An unsupported or malformed non-affine mapping exits 1 with a named
      incomplete or error result.
- [ ] Existing bilevel and grayscale reports remain stable unless a reviewed
      correction explains the change.
- [ ] Unit tests prove incomplete enforced coverage still exits 1.

Primary paths:

- `scripts/diagnostics/scan-cleanup-word-loss-audit.mjs`
- `tests/unit/scripts/scanCleanupWordLossAudit.test.ts`
- `scripts/ci/scan-cleanup-oracles.sh`
- the durable RGB fixture selected by NAB-EVID-001

### NAB-FOLD-001, retain fold-side text

Issue title:

`Fold-band exclusion removes gutter-side line starts on photographed spreads`

Verified failure:

- Source page 41 is the tight reproduction.
- The measured fold band omits a 95-pixel full-resolution central region.
- The right source region begins at the curved line starts.
- `--no-crop-content` does not restore the missing letters.
- Similar repeated inner-edge loss appears across dozens of cleaned leaves.

Required design:

- Check meaningful text-like support before the measured fold band becomes a
  leaf edge.
- Shrink an overlapping band toward the cutter.
- Retain the gutter at the cutter when the safe boundary remains ambiguous.
- Keep this safeguard in split or render-plan ownership. Do not create a
  cross-stage support framework as part of this package.

Acceptance criteria:

- [ ] Page 41 retains every source-supported line start.
- [ ] The RGB and non-affine oracle measures the reproduction.
- [ ] Existing tracked gutter fixtures do not shift outside their recorded
      tolerance.
- [ ] Blank-leaf gutter cleanup and nonblank preservation tests remain green.
- [ ] The page-change ledger names every corpus leaf whose source region or fold
      band changes.

Primary paths:

- `native/scan-cleanup/src/split.rs`
- `native/scan-cleanup/src/engine/render_plan.rs`
- `native/scan-cleanup/src/engine/render.rs`
- `native/scan-cleanup/tests/fixtures/gutter/`

### NAB-MIXED-001, reject destructive Mixed ownership

Issue title:

`Auto selects Mixed on photographed text pages and fragments protected text`

Verified failure:

- Source page 52 reproduces cleaned page 101.
- Auto recommends Mixed with reason `text-with-pictures`.
- Picture fraction is `0.4207533759772566`.
- A protected text block overlaps 271,704 picture-mask pixels.
- No picture exists on the affected leaf.
- Forced Gray and Color retain the printed page. Auto/Mixed fragments it.
- Similar destructive output appears on cleaned pages 54, 149, and 151.

Required design:

- Compare protected text support with the normalized source at analysis
  resolution before publishing a Mixed recommendation.
- Treat large picture-mask overlap with protected text as contradictory unless
  independent evidence proves a photograph or graphic.
- Fall back to Gray when text fidelity fails. Use Color when verified color
  content requires it.
- Do not render a second full-resolution candidate merely to make the decision.

Acceptance criteria:

- [ ] Page 52 selects Gray or Color and retains its full printed text.
- [ ] Existing real mixed-page fixtures remain Mixed.
- [ ] A mutation that removes the contradiction check reproduces the page-52
      failure or fails its minimized oracle.
- [ ] The page-change ledger records every mode change in the existing corpus.
- [ ] Runtime and scratch growth remain inside the recorded tolerance because
      the comparison stays at analysis resolution.

Primary paths:

- `native/scan-cleanup/src/mode_select.rs`
- `native/scan-cleanup/src/engine/render.rs`
- `native/scan-cleanup/tests/mode_select_real.rs`
- `native/scan-cleanup/tests/fixtures/split/`

### NAB-SPREAD-001, recover five physical spreads

Issue title:

`Outer-margin veto leaves five photographed book spreads unsplit`

Verified failure:

| Source page | Physical content | Current cleaned result |
| ---: | --- | --- |
| 31 | Blank left leaf plus manuscript title plate | Page 61, blank leaf absent |
| 32 | Manuscript facsimile plus titled facing leaf | Page 62, whole spread retained |
| 33 | Blank left leaf plus printed Latin page | Page 63, blank leaf absent and text clipped |
| 101 | Two dense printed leaves | Page 198, whole spread retained |
| 147 | Two dense index leaves | Page 289, whole spread retained |

Pages 101 and 147 have strong whitespace, bilateral, gutter, aspect, and page
surface evidence. Their outer-margin scores are `0.0000` and `0.0175`.
`outer_margin_score` takes the minimum left and right edge score, so one weak
outer edge vetoes the standard spread path. The code documents this as a policy
gate rather than a compensating score.

Experiment A, conditional local recovery:

- Preserve left and right outer-edge evidence separately during the experiment.
- Allow one contaminated edge only when page bodies, central gutter, aspect,
  and offcut rejection meet recorded strict bounds.
- Reject the approach if true-single or offcut false splits increase.

Experiment B, cohort reconciliation:

- Preserve a plausible local cutter after abstention.
- Reconcile only inside a same-capture cohort with matching oriented
  dimensions, scale, bilateral page surfaces, central gutter evidence, and no
  single-sheet or offcut evidence.
- Reject the approach if a document prior substitutes for missing local page
  or gutter evidence.

Required negative corpus:

- [ ] True single photographed pages with clutter on one outer edge.
- [ ] Narrow offcuts beside a real page.
- [ ] Mixed documents containing both spreads and genuine single inserts.
- [ ] Existing hard single-page fixtures in the real split corpus.

Selection rule:

Choose the smaller approach only after both experiments produce a complete
before-and-after classification ledger. If neither preserves the true-single
corpus, land neither and retain manual layout overrides.

Acceptance criteria:

- [ ] Source pages 31, 32, 33, 101, and 147 produce two physical leaves.
- [ ] With blank skipping off, the full document produces 296 leaves.
- [ ] The shared matched canvas no longer becomes landscape because of an
      unsplit spread.
- [ ] No tracked true-single or offcut fixture changes to a spread.
- [ ] Blank skipping on and off differ only at the later blank-page policy.
- [ ] The selected approach records why the rejected alternative was unsafe or
      unnecessary.

Primary paths:

- `native/scan-cleanup/src/split.rs`
- `native/scan-cleanup/tests/split_real_fixtures.rs`
- `native/scan-cleanup/tests/detect_document_consistency.rs`
- `native/scan-cleanup/tests/fixtures/split/`

## Issue-publication package

NAB-ISSUES-001 is ready for drafting but awaits authorization to publish. Each
issue must contain:

- the source and cleaned SHA-256 values;
- the relevant manual-review rows copied into the issue body;
- one tight reproduction command that does not depend on an ignored path;
- the durable fixture path or external checksum branch;
- current behavior and expected behavior;
- the named code owner and confirmed mechanism;
- acceptance criteria copied from this ledger;
- compatibility and good-page invariants;
- explicit non-goals;
- dependency on the oracle or fixture package where applicable.

Do not attach the 1.1 GB render set. Do not publish local absolute paths as if
another contributor or CI can reach them.

## Page-change ledger

Every behavior package must produce a machine-written candidate table and a
human disposition for each changed page. Use this schema:

| Field | Required value |
| --- | --- |
| Source identity | Fixture ID or source-document SHA-256 plus source page |
| Output mapping | Output pages before and after |
| Settings | Layout, mode, binarization, crop, matched size, blank skip, dewarp |
| Stage decision | Split class, cutter, fold band, output mode, dewarp accepted |
| Dimensions | Source region, content box, raster, and output canvas |
| Baseline verdict | No material loss, major, catastrophic, or layout-only |
| Candidate verdict | Same normalized scale plus source-supported rationale |
| Automated checks | Word-loss, catastrophe, mode, split, and mapping results |
| Human review | Reviewer, date, and disputed or accepted status |
| Evidence | Artifact path plus SHA-256 |

The ledger must include unchanged positive controls, not only pages fixed by the
candidate. Generated tables must record their command and baseline SHA.

## Common definition of ready

Before changing production code in a package:

- [ ] `main` is clean and the package records the current local and remote SHA.
- [ ] The fixture decision is resolved for every real page the package needs.
- [ ] A positive and negative fixture fail or pass on the baseline as expected.
- [ ] The issue, if published, matches this ledger and has no dead local links.
- [ ] The package names one behavior owner and one fallback path.
- [ ] The target test command passes before the first production edit.
- [ ] Existing unrelated work is identified and preserved.

## Common definition of done

For every implemented package:

- [ ] Targeted regression tests fail on the old behavior and pass on the
      candidate, with a mutation or equivalent proof where practical.
- [ ] `pnpm run validate:iteration` passes.
- [ ] Rust changes pass `pnpm run lint:rust` and the applicable native library
      and `page_cli` targets.
- [ ] `pnpm run test:scan-cleanup:affected-oracles` runs before the first push.
      Record whether each oracle ran or skipped, its exit status, and its output
      path. Investigate any unexpected skip.
- [ ] The applicable real native corpus lane passes.
- [ ] The package produces its before-and-after page-change ledger.
- [ ] One real-app or CLI artifact proves the user-visible result when the
      package changes rendered output.
- [ ] CodeRabbit CLI review against `main` completes within the repository pass
      limit, or the fail-open reason is recorded after normal verification.
- [ ] `node scripts/review-cubic-commits.mjs --commit HEAD` runs before push.
- [ ] Useful review findings are fixed and changed diffs are re-reviewed.
- [ ] The implementation commit lands on `main` and required CI passes.
- [ ] The closure record contains the exact commit, CI run, commands, counts,
      review dispositions, artifact hashes, remaining risks, and next package.

NAB-FULL-001 adds these final gates:

- [ ] Regenerate the full 148-page output from the recorded source hash and
      settings.
- [ ] Manually inspect every changed output and every page named major or
      catastrophic in the baseline.
- [ ] Confirm 296 physical leaves with blank skipping off.
- [ ] Confirm zero catastrophic outputs.
- [ ] Confirm zero detected source-supported text loss.
- [ ] Confirm every previously good page is unchanged or has a reviewed,
      source-supported improvement.
- [ ] Record final PDF SHA-256, byte size, page count, canvas distribution, and
      renderer compatibility result.

## Local closure record

Package: `NAB-EVID-001`, `NAB-DEWARP-001`, `NAB-ORACLE-001`,
`NAB-FOLD-001`, `NAB-MIXED-001`, `NAB-SPREAD-001`, and `NAB-FULL-001`

State: Verified.

Issue: None. Issue publication was not authorized or required.

Implementation baseline SHA:
`c23eed1fd5cb7328eb9020cdafefa985f5c0255f`

Implementation commit SHA:
`4134d8d84b8b830b193661567ad30e8221879f70`

Coverage follow-up commit SHA:
`e652c32745fdf1bf15b76c29929aaccc0dca0d38`

Changed scope:

- automatic-dewarp text-component containment and rejection;
- fold-side column support for automatic, manual, and full-resolution split
  paths;
- conservative one-weak-outer-edge spread recovery plus a guarded
  CropBox-to-MediaBox retry;
- protected-text ownership checks before Auto publishes Mixed;
- RGB and non-affine word-loss comparison, generated RGB CI evidence, and a
  checksum-verified real-source corpus lane;
- stable-header registration in the assembled artifact audit so body dot
  leaders do not create false page shifts;
- protocol evidence, codecs, adapters, tests, and this ledger.

Fixture identities and SHA-256:

- Nabuco source:
  `de50d9a355e0242162a1868319c423308bbc836212ca01bc47fb3d18c7d15375`;
- external corpus pages: `3, 31, 32, 33, 41, 52, 101, 147`;
- generated RGB fixture is rebuilt and checked by
  `scripts/ci/scan-cleanup-oracles.sh`;
- no source-publication bytes are tracked.

Commands and exact results:

- `EVB_GATE_CAPACITY=1 node .agents/skills/run-all-gates/scripts/run-all-gates.mjs --only validate`:
  passed. It covered 1,084 files and 9,102 tests, 596 scan-cleanup library
  tests with 6 ignored, strict build, bundle integrity, and 7 blocking Electron
  smoke tests with 5 intentionally skipped variants. Summary:
  `.devkit/gates/2026-08-24T205546Z/summary.json`.
- external Nabuco corpus verifier: 1 fixture, 27 assertions, 0 failures; all
  16 output pages passed the assembled artifact audit. Summary SHA-256:
  `4cf8953927f1829dfa5bb8d2ecc9f4bf159d063986dffa861be2bd1d89ae9f3d`.
- `pnpm run test:scan-cleanup:affected-oracles`: exit 0, native catastrophes
  0, RGB text-loss flags 0. The pre-existing RGB preview-weight warning remains
  diagnostic and is not an enforced text-loss failure.
- `pnpm run test:coverage` after the coverage follow-up: 1,085 files and 9,108
  tests passed. The coverage ratchet passed, including scan-cleanup-adapters at
  71.11% statements, 68.38% branches, 80.70% functions, and 72.13% lines. The
  zero-execution tripwire passed for 175 production files, including all 18
  changed production files.
- `pnpm run diag:verify-generated-pdf` on the 16-page representative real
  output: `classified-compatible`, 0 failures. Compatibility report SHA-256:
  `76ad9c579b2c1edc8c3e024ea91de06ce8b5b3e87eaea07db4e1d4a4da55bdd2`.
  The inspected contact sheet SHA-256 is
  `4031941c36fd0d87ee6c66380be4212fe7f9b1adca1b0a03918d2c25040f24e7`.
- `qpdf --check` on the final 148-source-page output: no syntax or stream
  errors.

Page-change ledger:

- all 148 source pages classify as photographed spreads and produce 296
  physical leaves with blank skipping off;
- automatic dewarp accepts 0 pages, replacing 20 known destructive accepts;
- page 52 and page 76 retain their printed text through Color rather than a
  destructive false Mixed result;
- source pages 35, 99, 101, 130, 132, and 138 retain fold-side text;
- the strict spread recovery and guarded box retry recover the previously lost
  spread structure, including pages 31, 32, 33, 101, and 147;
- broad retry for already detected spreads and raw-versus-normalized cutter
  reconciliation were rejected because they admitted red-cloth or facing-page
  residue.

Manual artifact and SHA-256:

- final PDF:
  `c3157f4b394e4f76f8b975734f12c049e26f593bfa2ddfe51307925dd7cc54b6`,
  62,922,633 bytes, 296 pages;
- final summary:
  `ab22f569f580479820027193bcdee99319605fcb3003c53e80ff560183de345a`;
- two final native Luna Max lanes reviewed all changed and baseline control
  pages. They found no major or catastrophic defect. Source page 4 retains a
  narrow facing-page strip on the nominally blank leaf. Pages 130 and 132 retain
  small dark outer-edge triangles. None obscures text.

CodeRabbit disposition: Two CLI passes completed against `main`. The first
reported 17 findings and the second reported 19. Useful findings were fixed,
including scratch admission, per-page retry containment, abort-safe bounded
geometry caching, unit-range protocol validation, non-finite and nonlinear
mapping guards, mapping-space validation, CropBox normalization, and admission
report ownership. Refactor-only and redundant-test suggestions were declined
after the applicable focused and full tests passed.

Cubic disposition: The implementation commit passed with 8 advisory findings
after the shared renderer-geometry refactor. The coverage follow-up passed with
one advisory about `Promise.withResolvers`; it does not apply because
`package.json` and every CI workflow pin Node 24.11.1.

CI run and conclusion:

- implementation run
  `https://github.com/evb0110/evb-viewer/actions/runs/32784610965` failed only
  the changed-file coverage tripwire. This exposed unexercised adapter and CLI
  paths and led to the follow-up commit;
- follow-up run
  `https://github.com/evb0110/evb-viewer/actions/runs/32787135451` passed. Quality
  Gates, Scan Cleanup Export Oracles, attribution, compatibility checks, and
  aggregate `gates_ok` are green for the exact published SHA.

Remaining risks and non-goals:

- the corpus still lacks a real curved page on which automatic dewarp is known
  to improve the result. The safety guard has synthetic positive coverage and
  real Nabuco negatives, but this change does not claim broader real-page
  dewarp quality;
- the minor page-edge residue above remains because broader removal damaged
  source-supported content in the rejected experiments;
- publishing issue specs and redistributing Nabuco extracts remain outside the
  authorized scope.

Next package unblocked: A separate real-positive automatic-dewarp corpus task.

## Closure record template

Append one record per landed package:

```text
Package:
State:
Issue:
Implementation baseline SHA:
Commit SHA:
Changed scope:
Fixture identities and SHA-256:
Commands and exact results:
Page-change ledger:
Manual artifact and SHA-256:
CodeRabbit disposition:
Cubic disposition:
CI run and conclusion:
Remaining risks and non-goals:
Next package unblocked:
```

## Current next action

No remediation package remains open. A future task may add a real curved-page
positive to measure automatic-dewarp quality, which this safety-focused change
does not claim to improve.
