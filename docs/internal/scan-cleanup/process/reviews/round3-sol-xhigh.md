# Round-3 verdict

v3 is not ready to become operative. Its direction is materially better than v2, but it still contains several load-bearing factual errors and conflates four different states:

1. code exists;
2. code can be invoked manually;
3. a workflow invokes it;
4. the result blocks landing.

The most serious errors are:

- v3 is not self-contained: it says F1–F15 “stand as amended” but does not define F2–F6, F8, F11, or F15 anywhere in the document.
- T3’s “all fixtures/corpora/books live on one Mac” is false.
- The H50 catastrophe comparator exists but is not wired into any package script, validation gate, or CI workflow.
- `scanCleanupMatchedCanvas` has eight tests, not seven.
- The repository already has performance measurements; C4 does not start from zero.
- R4 contradicts the declared 30-green-run graduation policy and omits the native-build prerequisites of the proposed blocking tests.
- The 3–5-day prior-art estimate covers a narrow monotonic-mask prototype, not every destructive path in the alleged 277-threshold lattice.
- A native GitHub merge queue is presently unavailable for this personal-account repository; the minimal design must use strict up-to-date PR protection plus exact-SHA post-landing CI, or move the repository to an organization.

## A. Factual audit of v3

### Document integrity and evidence provenance

- **Refuted — v3 is not an operative/self-contained specification.** It incorporates only selected corrections and then declares F1–F15 to stand, leaving eight failure classes undefined. A reader cannot reconstruct the governing taxonomy from v3 alone. See [v3:36](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:36) and [v3:94](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:94).

- **Unverifiable — “reports validated” and “every load-bearing claim spot-verified.”** The referenced reports were in `/tmp`; v3 stores neither them nor their digests. v3 itself recognizes this at F18. The document therefore cannot prove its line-4 provenance assertion. See [v3:3](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:3) and [v3:104](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/DEV-VALIDATION-APPROACH-2026-08-14.md:104).

- **Verified, with an important consequence — `.devkit` is ignored and rejected by local policy.** That applies to v3, the ledger, SEAM-MAP, private manifests, and most proposed evidence currently living there. It does not apply to all scan-cleanup fixtures. See [.gitignore:16](/Users/evb/WebstormProjects/evb-viewer/.gitignore:16).

### Failure-class corrections

- **Verified — F1’s narrower closure criticism.** The ledger recorded Wolf as outside the G3 scope and later recorded residuals; “closed” rhetoric nevertheless persisted through later reopenings. See [ledger:911](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:911) and [ledger:1038](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1038).

- **Refuted — F7 says `matchedCanvas` has seven tests.** It has eight: one environment-gated representative-canvas test at [matchedCanvas:576](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupMatchedCanvas.e2e.test.ts:576), followed by seven ungated tests beginning at [matchedCanvas:671](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupMatchedCanvas.e2e.test.ts:671) and ending at [matchedCanvas:1175](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupMatchedCanvas.e2e.test.ts:1175). The truthful statement is “one of eight is gated; seven are ungated.”

- **Verified — two scan-cleanup specs are fully environment-gated.** `appTruthProbe` gates at module level around [appTruthProbe:20](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupAppTruthProbe.e2e.test.ts:20); `uniformity` does likewise at [uniformity:58](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupUniformity.e2e.test.ts:58).

- **Verified — journey and layout-stability are unconditional and construct their own fixtures.** See [journey:47](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupJourney.e2e.test.ts:47) and [layoutStability:89](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupLayoutStability.e2e.test.ts:89).

- **Verified — the quarantine contains nine specs.** All nine are enumerated in [graduation-policy.json:13](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/graduation-policy.json:13).

- **Verified — the current lane is non-blocking, retrying, and empty-lane-green.** The policy says `blocking:false`, 30 consecutive greens, and zero recorded runs at [graduation-policy.json:4](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/graduation-policy.json:4). The architecture test expressly pins `continue-on-error:true` and `--passWithNoTests` at [quarantineGraduationPolicy.test.ts:147](/Users/evb/WebstormProjects/evb-viewer/tests/unit/architecture/quarantineGraduationPolicy.test.ts:147).

- **Materially misleading — “three of five specs could move to blocking in one commit.”** A single commit is mechanically possible, but not as the implied move-only change. The blocking project currently includes only `prBlockingSmoke` at [vitest.shared.config.ts:82](/Users/evb/WebstormProjects/evb-viewer/vitest.shared.config.ts:82), and its package command builds Electron but not the three native binaries or page-ops support needed by the scan-cleanup tests. The regression and quarantine commands do build those prerequisites; compare [package.json:68](/Users/evb/WebstormProjects/evb-viewer/package.json:68) with [package.json:69](/Users/evb/WebstormProjects/evb-viewer/package.json:69). `matchedCanvas` would also need splitting or retagging because only some tests are ungated.

- **Contradiction — R4 demands immediate graduation while treating 30 green scheduled runs as the “true blocker.”** Current machine-readable counters are zero. Either machine-derived history must prove 30 clean non-skipped runs, or v4 must call the move an explicit policy waiver. Updating the JSON and its architecture test together does not manufacture the missing execution history.

- **Verified — F9’s two-sided test caught a wrong diagnosis.** The ledger records the smoothing diagnosis and later correction at [ledger:834](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:834) and [ledger:888](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:888). It does not establish that fixture adjudication was independently checked.

- **Verified — F10’s two cited runs were canceled by ref-wide concurrency.** The workflow groups push runs by event/ref and enables cancellation at [ci.yml:3](/Users/evb/WebstormProjects/evb-viewer/.github/workflows/ci.yml:3). GitHub records both [6ff126e as canceled](https://github.com/evb0110/evb-viewer/actions/runs/31720903629) and [adab5a4 as canceled](https://github.com/evb0110/evb-viewer/actions/runs/31662409436), explicitly because a higher-priority request for the same group arrived.

- **Stale — “the current tip is queued/no green tip.”** Current public state shows `7f9af7d` completed successfully in 8m01s. R0’s “obtain a green run” is already satisfied, although the structural cancellation defect remains. See the [current successful run](https://github.com/evb0110/evb-viewer/actions/runs/31744750142).

- **Verified — direct pushes land before CI validates them.** Commit `1b15c1d` was pushed to `main` and its subsequent CI failed. The next direct push repaired the tip. That proves there was no effective pre-landing PR/check barrier for those commits. See the [failed main-push run](https://github.com/evb0110/evb-viewer/actions/runs/31744352332).

- **Unverified — “force-push allowed.”** Public Actions prove direct pushes are accepted, but unauthenticated repository views do not expose the live ruleset setting. v3 should distinguish “direct push empirically accepted” from “force-push setting inspected.”

- **Verified — the ledger’s eight/nine hygiene failure.** It says “now nine” at [ledger:1054](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1054), later says “all eight” at [ledger:1122](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1122), and then opens REOPEN 6 at [ledger:1145](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1145).

- **Verified — CodeRabbit does not enforce landing.** `.coderabbit.yaml` disables change-request reviews at [.coderabbit.yaml:6](/Users/evb/WebstormProjects/evb-viewer/.coderabbit.yaml:6). Direct-push history independently proves the absence of a PR-only path.

### Harness, audit, ratchet, and corpus claims

- **Mostly verified — preview harness correction.** It computes `rasterIdentical` and `inkMarginShift`, but only overlay containment is added to provisional violations at [preview-harness:992](/Users/evb/WebstormProjects/evb-viewer/scripts/diagnostics/scan-cleanup-preview-harness.mjs:992); final weight/margin/overlay failures are checked at [preview-harness:1040](/Users/evb/WebstormProjects/evb-viewer/scripts/diagnostics/scan-cleanup-preview-harness.mjs:1040). The final `--check` result folds those violations at [preview-harness:1102](/Users/evb/WebstormProjects/evb-viewer/scripts/diagnostics/scan-cleanup-preview-harness.mjs:1102).

- **Important caveat — `rasterIdentical` is not byte identity.** It is a 150-DPI composed-raster comparison produced by a synthetic provisional/final replay. It does not prove source-PDF bytes, output-PDF bytes, native intermediate bytes, or the actual Electron event sequence are identical. The harness manually constructs provisional and settled runs at [preview-harness:946](/Users/evb/WebstormProjects/evb-viewer/scripts/diagnostics/scan-cleanup-preview-harness.mjs:946).

- **Refuted as enforcement — the catastrophe ratchet is not a gate today.** `compare_catastrophes` rejects only counter increases at [evaluate.rs:401](/Users/evb/WebstormProjects/evb-viewer/native/scan-cleanup/src/bin/scan-cleanup-harness/evaluate.rs:401), but it executes only when the caller supplies `--baseline` at [main.rs:63](/Users/evb/WebstormProjects/evb-viewer/native/scan-cleanup/src/bin/scan-cleanup-harness/main.rs:63). No package script, validation plan, or CI workflow invokes `scan-cleanup-harness` or supplies the baseline. The only automated proof is a unit mutation of the comparator itself at [evaluate.rs:1048](/Users/evb/WebstormProjects/evb-viewer/native/scan-cleanup/src/bin/scan-cleanup-harness/evaluate.rs:1048).

- **Verified — the baseline has the stated nonzero catastrophe entries.** See [harness-baseline.json:1](/Users/evb/WebstormProjects/evb-viewer/native/scan-cleanup/harness-baseline.json:1) and [harness-baseline.json:23](/Users/evb/WebstormProjects/evb-viewer/native/scan-cleanup/harness-baseline.json:23).

- **Omitted bypass — the comparator ignores corpus inventory and all metrics.** Removing a fixture, relabeling it, substituting another baseline, or degrading `minimumIou` can still pass as long as counted catastrophes do not increase. Re-adjudicating four current nonzero fields does not fix that denominator attack.

- **Verified — the representative audit has eight declared classes and collapse accounting for four.** The class list is at [representative-audit:1791](/Users/evb/WebstormProjects/evb-viewer/scripts/diagnostics/scan-cleanup-representative-audit.mjs:1791); only component survival, facing margins, leaf alignment, and leaf scale feed the collapse denominator at [representative-audit:1821](/Users/evb/WebstormProjects/evb-viewer/scripts/diagnostics/scan-cleanup-representative-audit.mjs:1821).

- **Under-scoped — “extend the same gate to the other four classes.”** Page-count exactness has no meaningful unmeasured state. Artifact/content/geometry checks have conditional applicability. The correct extension is a per-class `measured | inapplicable(reason) | missing(reason)` result, not a generic denominator copied to all four.

- **Refuted — “no latency tool exists in-tree” and C4 “starts from zero.”** The Rust harness already records wall time in `NonComparableReport` at [evaluate.rs:209](/Users/evb/WebstormProjects/evb-viewer/native/scan-cleanup/src/bin/scan-cleanup-harness/evaluate.rs:209) and per-entry timing at [evaluate.rs:285](/Users/evb/WebstormProjects/evb-viewer/native/scan-cleanup/src/bin/scan-cleanup-harness/evaluate.rs:285). `matchedCanvas` also has explicit performance/latency expectations around [matchedCanvas:653](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupMatchedCanvas.e2e.test.ts:653) and [matchedCanvas:1200](/Users/evb/WebstormProjects/evb-viewer/tests/e2e/electron/quarantine/scanCleanupMatchedCanvas.e2e.test.ts:1200). The truthful claim is: no controlled, blocking, comparable preview-latency baseline exists.

- **Refuted — T3’s “all fixtures/corpora/books live on one Mac.”** The native corpus builder assembles tracked split, glyph, and synthetic fixtures at [corpus.rs:89](/Users/evb/WebstormProjects/evb-viewer/native/scan-cleanup/src/bin/scan-cleanup-harness/corpus.rs:89), with its tracked fixture root at [corpus.rs:694](/Users/evb/WebstormProjects/evb-viewer/native/scan-cleanup/src/bin/scan-cleanup-harness/corpus.rs:694). The checked-in baseline identifies a 50-entry corpus. Journey/layout fixtures are also self-generated. Only the private standing corpora and full books have the asserted residency problem.

- **Verified — private standing manifests contain absolute Mac paths.** See [.devkit/scan-cleanup-regress.json:3](/Users/evb/WebstormProjects/evb-viewer/.devkit/scan-cleanup-regress.json:3).

- **Verified — current nightly scan regression is hosted, optional, and not self-hosted.** It uses `macos-14`, depends on a repository variable, and stages native binaries at [ci.yml:581](/Users/evb/WebstormProjects/evb-viewer/.github/workflows/ci.yml:581). No workflow contains `self-hosted`.

- **Needs four-way corpus terminology.**

  1. H50: tracked, runner-buildable, baselined, currently unwired.
  2. Private standing regression fixtures: absolute-path manifests and partially specified expectations.
  3. Linguae discovery/extracted corpus: broad triage with proxy expectations, not trustworthy page-level semantic truth.
  4. Full books: local/VPS pre-release material.

  Calling the second and third simply “the 250 corpus” loses essential oracle and residency distinctions. The ledger’s 250-PDF discovery, 12 skipped DjVu, and outcome accounting are at [ledger:536](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:536). An earlier 1,483-PDF inventory explicitly warns that expectation mismatches are triage, not accuracy, at [CORPUS-SWEEP-REPORT:17](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/CORPUS-SWEEP-REPORT.md:17).

### CI, validation, provenance, and architecture

- **Verified — pull-request CI runs full lint/type/unit; local acceptance is scoped.** PR Quality Gates run the complete unit command at [ci.yml:56](/Users/evb/WebstormProjects/evb-viewer/.github/workflows/ci.yml:56). `pnpm validate` uses affected-plan selection and related tests at [validation-gates.mjs:318](/Users/evb/WebstormProjects/evb-viewer/scripts/validation-gates.mjs:318) and [validation-gates.mjs:420](/Users/evb/WebstormProjects/evb-viewer/scripts/validation-gates.mjs:420). C1 must not say “full unit suite, never scoped” without saying “in required PR CI”; it is false for current local acceptance.

- **Unproven — “CSS lint escaped scoped gates this very night.”** The ledger supports the broader lesson that scoped tests missed a full-suite failure at [ledger:927](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:927). It does not, by itself, prove that the omitted check was specifically CSS lint.

- **Verified — development app version is constant/package-derived.** See [appVersion.ts:1](/Users/evb/WebstormProjects/evb-viewer/electron/appVersion.ts:1) and [package.json:4](/Users/evb/WebstormProjects/evb-viewer/package.json:4).

- **Verified but overstated — exported PDFs carry native hashes.** Build-manifest hashing covers the scan-cleanup, image-combine, and page-ops binaries at [buildManifest.ts:27](/Users/evb/WebstormProjects/evb-viewer/scan-cleanup-core/buildManifest.ts:27), and the provenance payload carries plan, source, mapping, and binary identifiers at [provenanceStamp.ts:103](/Users/evb/WebstormProjects/evb-viewer/scan-cleanup-core/provenanceStamp.ts:103). It does not carry a Git commit SHA or renderer-bundle hash; `SCAN_CLEANUP_CORE_BUILD_ID` is a fixed constant at [provenanceStamp.ts:34](/Users/evb/WebstormProjects/evb-viewer/scan-cleanup-core/provenanceStamp.ts:34). The stamp is canonical encoding, not a cryptographic signature.

- **Overstated — SEAM-MAP is not yet authoritative.** It contains unresolved `?` markers and assumptions, for example the assembler fallback at [SEAM-MAP:4](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/SEAM-MAP-2026-08-14.md:4), thumbnail DPI at [SEAM-MAP:9](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/SEAM-MAP-2026-08-14.md:9), and transition assumptions at [SEAM-MAP:15](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/SEAM-MAP-2026-08-14.md:15). It is also ignored, so CI cannot consume it.

- **Refuted in scope — E1’s 3–5-day estimate.** The prior-art atlas estimates 3–5 focused days for the narrow photo/facsimile monotonic-mask direction, not for guarding all destructive paths in the threshold lattice. See [PRIOR-ART-ATLAS:21](/Users/evb/oss-repos/PRIOR-ART-ATLAS.md:21) and its focused-harness qualification at [PRIOR-ART-ATLAS:28](/Users/evb/oss-repos/PRIOR-ART-ATLAS.md:28).

- **Omitted — a conservation guard already exists.** Rendering already computes exclusive text/picture ownership and performs a conservative rollback around [render.rs:1243](/Users/evb/WebstormProjects/evb-viewer/native/scan-cleanup/src/engine/render.rs:1243). It can be bypassed when no mask exists and is followed by additional destructive fold-edge filtering at [render.rs:5877](/Users/evb/WebstormProjects/evb-viewer/native/scan-cleanup/src/engine/render.rs:5877). E1 is therefore an extension/finalization of an incomplete invariant, not a greenfield redesign.

- **Unreproducible — “~277 thresholds, 14 passes.”** The ledger records that count at [ledger:128](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:128), but there is no checked-in census, query, or source inventory from which another reviewer can reproduce it. It should be labeled a historical manual estimate.

- **Overgeneralized — F16’s “all enforcement machinery failed.”** Six architecture-test files exist, but only the quarantine test demonstrates the cited self-declared/non-blocking pattern. Other architecture tests enforce actual source policies. “All” is not supported. Nor is a required pre-landing check demonstrated while direct pushes remain accepted.

## B. Attack on T1–T3

### T1: “judgment-free” is the wrong thesis

The useful target is **policy-bound judgment**, not judgment-free enforcement. Judgment re-enters at every mechanism’s input boundary:

- **Byte identity:** which surfaces, files, pages, phases, encodings, DPI, normalization, and expected mutable regions belong in the identity set.
- **Ratchets:** catastrophe taxonomy, fixture labels, corpus membership, denominator, applicability, baseline revision, and whether an increase is legitimate.
- **Stop rules:** trigger definition, clock origin, retry classification, exception authority, and whether new evidence reopens the clock.
- **Two-sided gates:** correctness of the specimen, equivalence of pre/post environments, expected failure reason, and whether the mutation actually attacks the claimed axis.
- **Severity/default S1:** what constitutes silent harm, preview falsification, or invalid ground truth; who may downgrade.
- **A3 parity:** selection of protocol fields and whether equal fields imply equal rendered behavior.
- **B2 ratification:** framing the repro shown to the user.
- **E1 masks:** deciding what is text, photo, dirt, crop-exempt, or protected.

T1 should become:

> Human judgment defines a versioned policy and oracle boundary; machines deterministically execute it, expose coverage/applicability, and reject unreviewed changes to that boundary.

Also, “preview = downscaled final” is not current architecture. Preview uses preview-mode metadata/CSS placement while final may physically resample/pad; SEAM-MAP documents the divergence at [SEAM-MAP:3](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/SEAM-MAP-2026-08-14.md:3) and [SEAM-MAP:7](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/SEAM-MAP-2026-08-14.md:7). It is an architectural goal, not an existing model.

### T2: only the middle of the event chain is currently buildable

Buildable now:

- Git SHA ↔ GitHub run ID.
- SHA ↔ workflow artifact digest.
- PDF ↔ source/plan/native-binary provenance.
- Fixture ↔ content digest.
- Harness output ↔ closure artifact digest.

Not buildable solely inside this repository:

- Canonical user-message event IDs.
- Proof that all user messages were ingested.
- Proof that copied “verbatim” content was not omitted or altered before commit.
- User ratification tied to a repository-visible immutable source event.

A hand-copied timestamp and verbatim string is still self-authored. Git also does not make the event immutable unless the protected branch and history controls are themselves enforced. Because the repository is public, committing raw user messages additionally risks private paths, secrets, and personal content; the public status is visible on the [repository page](https://github.com/evb0110/evb-viewer).

T2 is buildable only if the host transcript/event stream becomes an authoritative input. Without that ingress, B1 can reduce accidental omission but cannot mechanistically detect it.

### T3: residency is real but not binding for all validation

The correct framing is:

- Residency blocks CI use of the private standing corpus and full books.
- Residency does **not** block H50, self-generated Electron fixtures, tracked expected-results schemas, unit tests, or architecture tests.
- H50 can become hosted-runner Tier A immediately; the private runner is not a prerequisite for that.
- Architecture is a recurrence source, but calling it “the only real cap” creates a false dichotomy. Governance can cap landing rate and escape rate while architecture work reduces generation rate.
- Architecture does not abolish judgment: its masks, applicability, route inventory, and conservative fallbacks still need trustworthy policy.
- The existing partial guard demonstrates the issue mechanistically: a mask can be absent, wrong, or followed by a later destructive operation.

Residency is therefore a scheduling constraint for some evidence, not an excuse to defer all CI enforcement.

## C. Enforcement audit, A1–E1

| Mechanism | Audited tuple | Surviving recurrence |
|---|---|---|
| **A1** | **Proposed, tuple not honest.** Path is ruleset plus multiple workflow changes, not “settings + one line.” Authoritative inputs are ruleset state, check source/name, tested SHA, and conclusions. Force-push status is unverified. A failing direct push is an unsafe injection; use a failing PR or temporary protected branch. | Direct push lands → exact-SHA run fails/cancels → later unrelated SHA is green → closure cites current green while defective SHA was never green. |
| **A2** | **Manual capability, not enforcement.** Comparator exists, but no gate invokes it. Inputs are hand-built fixtures, hand labels, caller-selected baseline, and counts—not simply “machine counts.” Bypasses: omit `--baseline`, raise baseline, remove/relabel specimen, or degrade ignored metrics. Required injection: one catastrophe increase **and separately** one corpus-removal attack. | Defect falls outside counted categories, or denominator shrinks; reported counters remain at/below baseline. |
| **A3** | **Proposed.** SEAM-MAP is ignored and unresolved. TypeScript types are erased at runtime; field enumeration is trustworthy only if derived from the runtime codec/schema actually decoding `nativeProtocolV3`. Bypasses include recomputation inside an existing consumer and unenumerated renderer/CSS state. | New deferred/lossless/preview branch consumes the same fields but reinterprets or recomputes one; census passes while geometry diverges. |
| **A4** | **Proposed; no named harness/audit mutation flags exist.** Binary hashes identify executables, not oracle correctness. “Two parties” dispatched by one orchestrator are not independent authorities. Required injection: wrong-label fixture plus a mutation that preserves output but destroys the supposed oracle axis. | Wrong ground truth is ratified twice; red/green and mutation tests faithfully validate the wrong claim, reproducing ledger P1. |
| **B1** | **Absent.** `docs/quality/reports` does not exist. Authoritative input is still manually selected/copied conversation content. | A report-shaped message is omitted from both register and close diff; the diff compares two self-authored incomplete sets and stays empty. |
| **B2** | **Process-only.** No executable path can prove what the user saw or that the reply ratifies every symptom. | Orchestrator frames a partial repro; user confirms the visible portion; omitted symptom is treated as closed. |
| **B3** | **Partial.** Export provenance identifies native binaries; displayed commit/renderer/request identity does not exist. | UI displays the current executable identity while a stale cache entry, prior request generation, alternate route, or later-staged binary supplies the pixels/output under review. |
| **B4** | **Absent and internally dependent on missing A1/B1.** One hour conflicts with observed 8–21-minute CI plus diagnosis/revert time. Automatic reverts are unsafe after another merge. | Report arrives near a concurrent landing; revert races the new tip, CI is canceled, or a forward fix is declared against a different SHA. |
| **B5** | **Absent.** Machine-generated tables prove only results over selected inputs; a digest proves artifact integrity, not completeness or freshness. | One harness/output is omitted, or an old closure artifact is reused; every included digest remains valid. |
| **C1** | **Proposed.** Current PR CI is full for unit/lint/type, while local `validate` is scoped. B2 ratification and private Tier A are not CI-readable. | Change is labeled S3 or surface matrix misses a shared consumer; conditional job skips and stable required check still appears green. |
| **C2** | **Absent.** Current `push:main` is exact-SHA-capable but cancellable; there is no aggregator, merge queue, or revert controller. | Two PRs validate against the same base; one lands; the other lands without revalidation, or one main run cancels the other. |
| **C3** | **Partial/local.** VPS corpus presence is ledger-recorded, not a configured runner. H50 is already runner-resident; private Tier A/B are not. | Local corpus mutates or machine is unavailable; closure cites a local report that CI cannot reproduce. |
| **C4** | **Measurement exists; comparable enforcement does not.** Five runs on one named machine are insufficient without workload digest, cold/warm policy, resource isolation, variance rule, and directionality. | Warm cache or idle machine masks a cold-path regression; later hardware/load changes create false passes or false reds. |
| **D1** | **Execution convention, not enforcement.** The single orchestrator owns diagnosis, severity, specimen framing, dispatch, and adjudication. Parallel Sol agents share those premises. | All agents independently reason from the same wrong oracle or omitted report and converge confidently. |
| **D2** | **Process-only and internally inconsistent.** “ONE review” is two reviewers; “one fix round” is arbitrary. CodeRabbit is fail-open and configured not to request changes. | A valid finding appears after the one fix round, or CodeRabbit skips/rate-limits; process still permits merge. |
| **D3** | **Not executable.** No landing maximum, “shared surface” definition, round wall-clock, or restart semantics are specified. One-hour soak cannot catch restart/reopen failures. | Land at the numeric boundary, delay closure 61 minutes, then close before a restart-dependent defect appears. |
| **E1** | **Partial existing guard plus proposed expansion.** Input is a hand/algorithm-derived ownership mask. Bypasses: absent/wrong mask, unguarded route, crop/topology loss, or post-guard destructive pass. | Guard retains currently marked pixels; later fold/crop/filtering deletes them—or no mask was produced—so the same content-loss class survives. |

## D. Answers to Q2–Q4

### Q2: stronger missing-row mitigation

The strongest design possible in this harness is a **source-event receipt chain**, not a report registry.

1. At session start, record a canonical session identifier and start cursor from the host transcript/rollout JSONL.
2. At close, an extractor enumerates **every user message**, not only “report-shaped” messages.
3. For each message emit:

   - session ID;
   - monotonic source event ID/sequence;
   - source timestamp;
   - SHA-256 of canonical raw content;
   - previous-event hash;
   - attachment digests;
   - required disposition: `defect`, `instruction`, `question`, `duplicate(ref)`, or `out-of-scope(reason)`;
   - linked issue/report rows where applicable.

4. Fail closure on a cursor gap, duplicate ID, broken hash chain, unclassified message, or a defect row lacking a disposition.
5. Keep raw message text in a private/encrypted host artifact; commit only hashes, approved redactions, event IDs, and dispositions to the public repository.
6. Include the terminal cursor and manifest digest in the close artifact shown to the user.
7. Closure becomes valid only when the user ratifies that exact manifest digest/end cursor.

This catches orchestrator omission because the extractor’s domain is all host events, not a self-selected subset. It also creates a second external endpoint: user confirmation of the final cursor/digest.

Hard limit: if the host exposes neither a durable transcript nor an ingestion hook, the missing-row problem is impossible to solve inside the repo. v4 should say “blocked on authoritative event ingress,” not “mitigated by a session rule.”

### Q3: minimal merge/SHA design for this repository

A native GitHub merge queue is not currently the minimal path—and may not be available at all. GitHub limits merge queues to organization-owned public repositories or eligible organization-owned private repositories, while `evb0110` is a personal user account. See the [GitHub merge-queue availability documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) and the [owner profile](https://github.com/evb0110).

The minimal buildable design today is:

1. **Protect `main`:**

   - require pull requests;
   - require the branch to be up to date before merging;
   - require one stable `Required CI` check from GitHub Actions;
   - block force pushes/deletions;
   - disable bypass for the normal operator/admin path.

   Strict up-to-date protection serializes two sessions: after PR1 lands, PR2 becomes stale and must update/re-run before it can merge.

2. **Create an always-present aggregator job.**

   - `if: always()`;
   - `needs:` every blocking job;
   - accept only `success` or intentional `skipped`;
   - fail for `failure`, `cancelled`, or missing conclusions.

   Require only this stable check name in branch protection.

3. **Fix concurrency by identity.**

   - PR: group by PR number; cancellation allowed for superseded commits to the same PR.
   - `push:main`: group by `${{ github.sha }}`; `cancel-in-progress:false`.
   - scheduled/nightly: separate group.

4. **Add a dedicated exact-SHA post-landing workflow.**

   - trigger `push` to `main`;
   - explicitly checkout `${{ github.sha }}`;
   - never cancel another SHA;
   - emit an attestation containing SHA, run ID, workflow digest, tool versions, and artifact digests;
   - record failures against that exact SHA.

5. **Revert safely.**

   - Freeze further merges on a red main SHA.
   - Auto-create a revert PR.
   - Direct automatic revert is permitted only if the failed SHA is still `main` tip and is a single-parent commit; otherwise no history mutation—use the revert PR and normal gates.

If the repository moves to an organization, then add `merge_group`, update every PR-only job condition to accept `merge_group`, and enable “require merge queue.” GitHub explicitly requires the `merge_group` trigger or the queue waits for a check that never appears. See [GitHub’s merge-group CI requirements](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue#configuring-continuous-integration-ci-workflows-for-merge-queues).

### Q4: E1 credibility and minimal invariants

**Estimate:** 3–5 days is credible only for a focused spike/prototype around the existing photo/facsimile guard and a bounded route set. It is not credible for:

- every destructive pass;
- raster final, preview, detail, deferred matching, lossless, fallbacks, compact assembly, and text overlay;
- mask/oracle calibration;
- mutation tests;
- corpus rollout and CI enforcement.

The proper sequence is: one route census and mutation spike, then estimate from measured uncovered paths.

**Minimal top-three invariant set:**

1. **Canonical geometry/placement plan**

   Create an immutable, runtime-validated `LeafPlan` once per output leaf, containing source region, split identity, transform, canvas, placement, overflow, optical bounds, DPI, and quality route. Preview, final, deferred matching, lossless, fallback, and provenance must consume or serialize the same plan—no recomputation.

   This caps recurring scale, vertical/horizontal shift, preview/final divergence, deferred-field loss, and lossless/raster drift recorded around [ledger:780](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:780), [ledger:1054](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1054), and [ledger:1105](/Users/evb/WebstormProjects/evb-viewer/.devkit/tasks/scan-cleanup/LEDGER-2026-08-11-auto-rescue.md:1105).

2. **Monotonic protected-content mask**

   Every destructive operation receives `(input, MustPreserveMask)` and must prove that protected source content survives in output coordinates. If no trustworthy mask exists, choose the conservative/non-destructive route. Validate again after the final destructive stage and assembly, not only mid-render.

   This addresses pale glyphs, footnotes, structural strokes, pictures/facsimile, and crop loss. The current guard’s absence and post-guard filtering demonstrate why final-stage validation is essential.

3. **Page-partition/cardinality conservation**

   A `PagePartition` must prove:

   - output source regions lie within the source page;
   - regions do not overlap except explicitly allowed seams;
   - their union covers all protected source content;
   - page cardinality changes require an independently evidenced split;
   - low-confidence topology defaults to unsplit/full-source.

   This caps missing leaves/pages, false landscape splits, offcut misclassification, destructive column splitting, and crop truncation.

These invariants prevent only violations relative to their masks/plans. Oracle assurance and route completeness remain necessary.

## E. Backlog R0–R9

### Item-by-item audit

- **R0 — partly complete, badly scoped.** Green tip is already obtained. The remaining work is ruleset protection, stable aggregator, strict up-to-date PRs, SHA-scoped concurrency, and exact-SHA post-landing attestation—not “settings + one line.”

- **R1 — premature and semantically unsafe.** Before gating `rasterIdentical`, define which state transitions must be identical. Provisional→settled evidence can legitimately change layout. Gate session-pinned preview/final parity, not arbitrary lifecycle equality.

- **R2 — insufficient.** Re-adjudication must be accompanied by actual gate wiring, frozen corpus inventory/digests, label-change review, metric policies, and a corpus-removal mutation.

- **R3 — ordered too early and falsely blocks H50.** Run tracked H50 on hosted CI first. Provision the private runner later with content-addressed corpus versions, security, availability, and artifact-retention policy.

- **R4 — contradicts policy and omits prerequisites.** It needs either proven 30-run history or an explicit waiver; native builds/page-ops support; matchedCanvas test separation; and skip/error accounting.

- **R5 — unsafe as written.** Do not commit raw verbatim user messages to a public repository. Build the canonical event extractor/private raw store first, then tracked receipts and redactions.

- **R6 — too narrow.** Surface request-time identity: Git SHA, renderer bundle hash, native binary set, route, source revision, request generation/cache key, and final provenance—not merely app version plus staged binary.

- **R7 — wrong abstraction.** Add per-class applicability and missingness; derive class identity from a runtime registry. Do not force page-count into an artificial “unmeasured fraction.”

- **R8 — premise wrong.** Timing exists. The task is comparable workload definition, environment/noise policy, cold/warm separation, variance threshold, and then blocking budgets.

- **R9 — correct only as a spike.** Inventory the existing guard, every post-guard destructive stage, route coverage, mask-absence behavior, and mutation surface before estimating implementation.

### Recommended v4 order

1. Make the specification self-contained; define status vocabulary and complete F1–F18.
2. Enforce strict PR/required-check/exact-SHA governance.
3. Wire H50 to hosted CI with inventory, label, baseline, and metric integrity.
4. Define canonical `LeafPlan` and preview lifecycle semantics; add tracked parity specimens.
5. Build source-event receipt extraction, private raw evidence, and digest ratification.
6. Repair/graduation-proof the blocking Electron scan-cleanup suite.
7. Add full build/request/cache provenance.
8. Provision private corpus runner and content-addressed Tier B/C artifacts.
9. Implement applicability-aware audit and controlled performance budgets.
10. Run E1 route/mutation spike, estimate, then implement the three invariants.

The omission that matters most is a **mechanism-state register**: every item must say `absent | manual | invoked-nonblocking | blocking | required-prelanding`, with the exact caller path. “Exists” and “enforced” must never share a status.

## F. Ranked top-seven changes for v4

1. **Correct and self-contain the factual model.** Restore all F1–F18 definitions; fix matchedCanvas 1-of-8, existing timing, H50 residency, current green tip, and E1 estimate/scope.

2. **Replace T1’s “judgment-free” claim.** State that policy/oracle judgment is versioned and reviewed, while its execution and change control are mechanized.

3. **Separate tracked H50 from private corpora and wire H50 now.** Add baseline invocation, corpus inventory/digests, label integrity, metric policies, and denominator mutations to hosted CI.

4. **Replace A1/C2 with the buildable personal-repo design.** Strict up-to-date PRs, stable required aggregator, SHA-scoped uncancelled main runs, exact-SHA attestations, and safe conditional revert. Treat organization migration as the prerequisite for native merge queue.

5. **Replace B1 with canonical source-event receipts.** Enumerate every user event from host transcript ingress, keep raw content private, fail on cursor gaps/unclassified events, and require user ratification of the terminal digest.

6. **Rewrite E1 around the existing partial guard and three concrete invariants.** Canonical `LeafPlan`, monotonic `MustPreserveMask`, and `PagePartition`; remove the unsupported broad 3–5-day promise.

7. **Rewrite every A1–E1 tuple with real enforcement level and failure injections.** Include caller, authoritative input, applicability/denominator, bypass, corruption/removal mutation, exact tested SHA, and the surviving recurrence documented above.

No files, commits, or Electron state were changed.
