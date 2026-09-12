# Remaining-problems closure record — 2026-08-16

This record closes the actionable inventory supplied after ledger row R21. It
does not convert future observation into evidence: the R20/R21 seven-day window
remains pending until 2026-08-23 and is tracked by GitHub issue #37.

## Product watch and routing

- **A1 / A2 — future observation, scheduled.** Issue #37 names the due date and
  exact rerun: fold exemplars at 0.00 mm drift, Vorwort offender count 0,
  whole-book offender total at most 1,212, and a user-report sweep including
  80R. The 80R route remains Otsu. An anchor refinement is permitted only after
  a user-visible report and the recorded anchor-delta RED/GREEN chain.
- **A3 — closed.** A line is sparse below 40 eligible components. Such a line
  may use the page median only when the page has at least 64 eligible components
  across at least two measured lines, and only when that median raises the
  denominator. Reports expose line population and fallback use. The committed
  RED/GREEN verdicts remain 6/0; the sparse-page calibration is 0 offenders plus
  one explicitly reported sub-floor component.
- **A4 — closed.** Publication of `existing_file_identity` now promotes the
  provisional path/revision detection lifecycle to its SHA-256 key without
  restarting native detection or dropping retained preview rasters. Completed
  detection is reusable after panel close/reopen when identity, revision, and
  settings match. Settings/revision changes and actual document close still
  invalidate it.
- **A5 — closed.** The unresolved leaf is 126L. Deskew confidence is 0.000, so
  crop and route diagnostics are intentionally absent while black-and-white
  output remains a typed success. The paired 126R leaf routes Otsu.

## Planned engineering

- **B1 — closed.** `estimated_stroke_width_px` is again sample-space data; the
  working-raster scale multiplication was deleted. Scale invariance, a
  production-size illumination-deviation-above-12 Sauvola fixture, and the 0.0
  degenerate route are pinned. The accepted-book inventory is unchanged at 288
  Otsu, 27 Wolf, 0 Sauvola, and 1 intentional unresolved leaf. The final
  whole-book oracle remains 1,212.
- **B2 — closed under ledger D3.** The unreachable final-render
  `preview_mode` branches and parameter, the O6 syntax-count tripwire and its
  generator/baseline/pin, and the workflow-dispatch-only native job were
  deleted. Rust tests, rustfmt/clippy, and cargo-deny remain in the PR/push
  native lane. Quarantine policy pins were preserved. The approach document was
  amended in the same change.
- **B3 — closed.** `docs/user/what-scans-work.md` declares the
  supported dense-text scan class, reachable modes, reference distribution,
  and unsupported/explicitly out-of-scope classes.
- **B4 — closed: drop both.** Integer three-pass shear remains falsified by
  staircase jitter and the impressum regression. The coverage-weight rescue
  gate has no remaining attributable offender class and does not justify a new
  production threshold. Both designs remain historical evidence only.

## CI and verification

- **C1 — closed with explicit adjudication.** `nanoid` is overridden to 3.3.18;
  production and full dependency audits report zero vulnerabilities, and the
  stale cargo-deny ISC allowance is gone. The advisory `weezl` 0.1/0.2 pair is
  explicitly retained through current `tiff` and `lopdf` upstreams. The newly
  reported dead export and four genuinely new duplicate groups were removed
  through shared validation,
  metadata, diagnostic grayscale, and representative-spread helpers. The
  duplicate baseline refresh contains 15 exact path-pair identities whose line
  positions moved, removes three clone groups eliminated by the refactor, and
  adds no new identity. The assistant-persistence `fsyncParentDirectory`
  overlap remains accepted because that path couples parent sync with distinct
  JSON/session durability semantics. Quarantine expectations now distinguish
  allowed intrinsic provisional canvases from the required settled document
  canvas. Isolated Electron wait expirations without a diagnostic trace remain
  accepted advisory findings; timeout budgets were not widened.
- **C2 — closed.** The Windows ARM64 build leg uses the native
  `windows-11-arm` runner, preflights the MSYS2 package tools, resolves the
  clangarm64 package source, and executes version, protocol, fold-clip, and
  packaged-content smokes on target. Cross-host invocation retains an honest
  named-gap message rather than claiming execution.
- **C3 — closed.** The four-page grayscale release fixture is tracked under
  `tests/fixtures/release/`. The resolver is fail-closed by default while
  preserving explicit overrides. `release.yml` downloads the actual packaged
  macOS ARM64 artifact, runs the CDP scale verifier, uploads its evidence, and
  blocks publication on that job.
- **C4 — closed.** `documentCanvas` owns fractional lossless placement and both
  lossless assemblers consume it. The preview/export harness table includes a
  `preserveOriginalQuality` row and quantizes only at the preview metadata
  boundary. A source-preserving four-page export passed qpdf and produced zero
  absolute-error pixels against source renders on every page. The PR #17 retro
  raster pack shows identical placement signatures and a working negative
  probe; its separate mixed-DPI weight warnings are outside placement identity.
- **C5 — retained scope statement.** The raster preview harness continues to
  claim raster placement identity and preview/final weight agreement, not
  absolute evenness. Lossless identity is covered by the shared placement owner,
  its harness row, and actual-export evidence above.

Retained local visual evidence (not source-controlled bulk artifacts):

- `.devkit/analysis/lossless-placement-retro-2026-08-16/README.md`
- `.devkit/analysis/pr17-retro-eyeball-2026-08-16/README.md`

## Governance and hygiene

- **D1 — decision: enforce.** At landing, require the exact `gates_ok` context
  on `main`, require review-conversation resolution, and disable force pushes.
  Preserve the existing Commit Attribution Policy requirement. Live settings
  verification is part of the landing attestation.
- **D2 — property retained.** Governance-only direct commits remain permitted
  under the recorded exception. This consistency pass reconciles the approach,
  supported-class declaration, weight handoff, and ledger together.
- **E1 — closed without deleting other owners' work.** All merged program heads
  from the backlog are gone. Open PR heads and the two older unowned branches
  are intentionally preserved; mergedness was checked through GitHub PR state,
  not ancestry.
- **E2 / E4 — closed.** `.devkit` measured 554 MB after retaining the two
  evidence packs, below the approximately 3 GB target. Dispatch-log count is
  zero. The committed C3 fixture removes the release verifier's former
  `.devkit` dependency, so no verifier depends on disposable scratch.
- **E3 — closed.** Attribution and deployment-source policy reject exact
  case-insensitive `HANDOFF.md`, `NOTES.md`, and `TODO.md` names outside the
  normalized top-level `docs/` tree, including nested and traversal-shaped
  paths. Policy tests pin intentional documents and near misses.

## Evidence summary

- Native routing: debug and release BW suites pass; the old scale mutation
  makes the production fixture route Wolf while the fixed code routes Sauvola.
- Corpus: 51 native fixtures, zero catastrophes; accepted route distribution
  288/27/0/1; whole-book weight total 1,212.
- Sparse oracle: focused unit/calibration suites pass; committed RED/GREEN 6/0.
- Detection lifecycle: 82 focused tests plus renderer and test-project
  typechecks pass.
- Lossless placement: document-canvas, preview, pipeline, qpdf, and rendered
  pixel-identity evidence pass.
- Policy/release: CI topology, release fixture/policy, artifact policy,
  Windows ARM64 policy, dependency audit, cargo-deny, and duplicate ratchet
  checks pass.

The pull request and merge SHA are recorded in the next ledger row only after
CodeRabbit reviews the final commit and the binding pre-merge check freshly
enumerates every `reviewThread` with zero unaddressed findings or unresolved
threads, and every required check finishes green.
