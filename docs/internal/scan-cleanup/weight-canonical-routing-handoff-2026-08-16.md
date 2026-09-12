# S5 canonical routing-plane correction handoff

## Disposition

The fixed 150-DPI canonical render remains the owner of layout, leaf resolution,
route choice, and spread reconciliation. The review corrections remove the
unrelated substitutions that had been attributed to that basis. The production
impressum still reports 14 standard stroke-oracle offenders (nominal limit 3),
but the component-level adjudication below accepts that sparse leaf: 13 are
non-widening local-median artifacts, the single widened ridge remains within
source support, and all 14 are source-supported. The Vorwort is 0 (limit 6) and
still routes Otsu at 299 DPI. No replacement anchor offset or threshold
weighting has been hidden to make the raw count green.

## Binding review items

1. **Normalized joint — corrected.** The joint candidate is cropped from the
   illumination-normalized canonical plane. Raw canonical leaves still own the
   two leaf candidates. This removes the raw-joint substitution while keeping
   all three candidates independent of working DPI.
2. **Intensity anchor — corrected and pinned.** Each paper/ink midpoint is
   measured over the full raw canonical leaf. A physically dilated picture mask
   is a histogram exclusion; it is not whitened into the paper population. The
   two-scale 150/300-DPI pin returns 127 at both scales. The production anchors
   are 129/127; the former <=256-pixel anchors 201/182 are gone.
3. **Drift semantics — explicitly canonical.** A literal restoration of
   working-raster drift was falsified: page 120/121 routes and reconciliation
   changed between 299 and 300 DPI. The retained semantics therefore measure
   x-height and faint-ink population on the full masked canonical leaves and
   compare *clamped radii at canonical DPI*, not raw x-heights. Actual selected
   radii are still scaled into working pixels. There is no 1.0-DPI sentinel;
   the 300-DPI fallback x-height is named `FALLBACK_X_HEIGHT_AT_300_DPI_PX`.
4. **Scratch memory — corrected.** `resolveRasterHandoff` budgets the fixed
   canonical render and simultaneous primary copies per resident page. The
   canonical scratch file is released on native `page-complete`, and all release
   promises settle before collection. The PNG fallback creates PNG canonical
   analysis input rather than writing raw PPMs. The measured canonical PPM is
   10,687,715 bytes/page, now bounded by raster concurrency rather than retained
   for the entire book.
5. **Preview parity — corrected.** Preview, final, and lossless analysis pass
   the paired canonical path/DPI contract. Detection's primary input is already
   the canonical 150-DPI raster, so it deliberately omits a duplicate analysis
   path (especially for its one-shot FIFO transport). The preview harness
   reports placement identity true and no violations.
6. **Stroke-width units — corrected after the routing landing.**
   `estimated_stroke_width_px` is measured and thresholded in the bounded
   routing sample, like the companion diagnostics. The former multiplication
   by the internal sample scale made the `<= 8` Sauvola arm unreachable on
   ordinary production-size pages. A four-times scale-invariance pin, a
   production-sized high-illumination Sauvola fixture, and the degenerate
   zero-stroke route now guard the unit contract.
7. **Real scale pin — corrected.** The render pin compares a 192x256 canonical
   raster at 150 DPI with a 384x512 working raster at 299 DPI, where
   `analysis_is_full` is false. The canonical bypass mutation remains red.
8. **Attribution/hygiene — corrected.** Basis changes and retained canonical
   drift semantics are separated above. The test-only `route()` accessor is
   removed. The measured canonical render cost is approximately 149 ms against
   2498.865 ms steady-state conversion, or about 5.9%.

## Route falsifier

Before the bounded near-boundary band, the final full-book inventory was
identical at 150, 299, and 300 working DPI:

- routes: 281 Otsu, 34 Wolf, 1 unresolved;
- reconciliation: 226 shared joint, 34 faint-ink drift, 2 anchor drift,
  8 radius drift, 45 route mismatch, 1 unresolved;
- route/reconciliation identity disagreements across the three DPIs: 0/316.

The base inventory was 275 Otsu, 39 Wolf, and 2 unresolved. The ten changed
route leaves are p2l2, p3l1, p45l2, p46l2, p80l2, p120l1/l2, p124l1/l2, and
p133l2. Side-by-side crops are in
`.devkit/analysis/s5-shear/canonical-routing/corrected-route-crops/`; inspection
found intact text on p2/p3/p45/p46/p80/p133 and intact, more legible plate
structure on p120/p124, with no crop loss or blanked content.

The bounded band below changes exactly seven further leaves from Wolf to Otsu,
so the landed inventory is 288 Otsu, 27 Wolf, and 1 unresolved. Fresh full-leaf
captures at 150, 299, and 300 working DPI report identical canonical coverage,
route, and reconciliation for all seven leaves, with 0 disagreements.

The unresolved leaf is 126L (source page 126, left). Its deskew confidence is
0.000, so the content crop is intentionally skipped and no route diagnostics
are emitted; the black-and-white page output remains successful and typed.
The paired 126R leaf routes Otsu. This is intended near-blank/low-confidence
behavior, not an analysis failure.

## Near-boundary flat-lit Otsu band

Canonical measurement found a bounded classifier gap immediately above the old
8% dark-border cliff. `FLAT_LIT_OTSU_DARK_BORDER_COVERAGE_BAND` is therefore
fixed at **0.099 through 0.11025 inclusive**, and it may select Otsu only when
the independent flat-lit contrast, illumination, edge, and agreement evidence
also passes. The captured set is exactly seven leaves; no tracked Wolf fixture
is captured, and the nearest of the nine fixtures remains below the floor at
9.868637110%.

| leaf | canonical dark-border coverage | route | route-focused oracle, base Wolf -> band Otsu | crop |
| --- | ---: | --- | ---: | --- |
| 46R | 9.945561139% | Wolf -> Otsu | 22 -> 2 | `.devkit/analysis/near-boundary-route/landing/crops/46R-base-wolf-band-otsu.png` |
| 25R | 10.222502099% | Wolf -> Otsu | 21 -> 1 | `.devkit/analysis/near-boundary-route/landing/crops/25R-base-wolf-band-otsu.png` |
| 132R | 10.631313131% | Wolf -> Otsu | 19 -> 1 | `.devkit/analysis/near-boundary-route/landing/crops/132R-base-wolf-band-otsu.png` |
| 48R | 10.678391960% | Wolf -> Otsu | 29 -> 3 | `.devkit/analysis/near-boundary-route/landing/crops/48R-base-wolf-band-otsu.png` |
| 33R | 10.812500000% | Wolf -> Otsu | 37 -> 11 | `.devkit/analysis/near-boundary-route/landing/crops/33R-base-wolf-band-otsu.png` |
| 34R | 10.816498316% | Wolf -> Otsu | 33 -> 9 | `.devkit/analysis/near-boundary-route/landing/crops/34R-base-wolf-band-otsu.png` |
| 80R | 11.024096386% | Wolf -> Otsu | 11 -> 6 | `.devkit/analysis/near-boundary-route/80r-adjudication/80R-source-base-band-2x.png` |

The five chronically bold leaves 25R, 132R, 48R, 33R, and 34R account for well
over 100 removed offenders in the measured base-Wolf comparison. The 46R crop
is recorded separately in the same crop directory. The threshold baseline was
regenerated from source and increases honestly from 180 to 181 named floating
constants.

The comparable native-parity whole-book sweep measures 1,212 offenders, down
155 from the origin/main base of 1,367 and down 160 from the pre-band candidate
of 1,372. Exactly the seven rows below change relative to pre-band; all seven
improve, so there is no new per-leaf regression. Relative to origin/main, 80R is
the sole band leaf that increases and is the adjudicated +4 exception.

| leaf | origin/main base | pre-band candidate | landed band | band vs base | band vs pre-band |
| --- | ---: | ---: | ---: | ---: | ---: |
| 25R | 29 | 28 | 1 | -28 | -27 |
| 33R | 32 | 35 | 7 | -25 | -28 |
| 34R | 31 | 34 | 4 | -27 | -30 |
| 46R | 5 | 22 | 2 | -3 | -20 |
| 48R | 30 | 29 | 1 | -29 | -28 |
| 80R | 2 | 13 | 6 | **+4** | -7 |
| 132R | 16 | 20 | 0 | -16 | -20 |

The candidate PDF has 316 outputs, passes `qpdf --check`, and records the native
parity assembler plus the patched scan-cleanup binary SHA-256. Artifacts are in
`.devkit/analysis/near-boundary-route/landing/wholebook-parity/`; the exact
three-way page ledger is `delta-audit.json`.

### 80R bounded regression adjudication

The comparable production record routes 80R through band Otsu and reports six
offenders against two at base, a bounded **+4** exception. Alignment on the
shared 2196x3241 book canvas shows that the band page is globally thinner by
10,446 ink pixels (815,298 -> 804,852). All six band offenders are supported by
the source. Four genuinely widen, by no more than 2.0 px; the other two retain
or reduce their ridge width and are local-median/population artifacts.

| # | class | base line: ridge/local median (px) | band line: ridge/local median (px) | source verdict |
| ---: | :---: | --- | --- | --- |
| 1 | a | L2: 7.000/4.394 | L2: 8.000/4.394 | supported |
| 2 | a | L6: 6.394/4.394 | L6: 7.197/4.394 | supported |
| 3 | b | L6: 8.000/6.000 | L6: 8.000/4.800 | supported |
| 4 | a | L11: 6.794/4.695 | L11: 7.597/4.394 | supported |
| 5 | b | L11: 8.000/4.997 | L11: 7.194/4.394 | supported |
| 6 | a | L42: 6.000/4.000 | L42: 8.000/4.394 | supported |

This exception is accepted because no deterministic canonical routing basis can
match the old DPI-accident baseline leaf-for-leaf; the same bounded band removes
the chronic boldness from the five leaves above and preserves the canonical
basis that fixes the user's pages. Omitting the band leaves 80R at Wolf with 13
production offenders, which is strictly worse. The machine-readable record is
`.devkit/analysis/near-boundary-route/80r-adjudication/forensics.json`.

## Validation evidence

- Production native render at 299 DPI: Vorwort Otsu, 0 offenders; impressum
  Otsu, 14 raw offenders, accepted by the combined component/pixel/source
  evidence below. Word-loss: 0 flagged/lost/damaged pages.
- Calibration and controls: 0 offenders; `wahrscheinlich` and `Handschrift`
  remain clean.
- Preview harness: placement identity true; word-loss 0.
- Native harness: 0 catastrophes across 51 fixtures; niqqud and punctuation
  goldens pass.
- All nine Wolf fixtures retain their Wolf route and are byte-identical to the
  packed-mask baseline; the nearest remains below the band at 9.868637110%.
- Fold exemplars: p3 right 1965 px and p125 right 2008 px, both 0-px / 0.00-mm
  drift.
- Focused Electron suites: 184/184 pass.
- Rust format, Clippy with warnings denied, the full release workspace suite,
  threshold baseline, and diff checks pass.

## Impressum sparse-page adjudication

The exact comparison replays committed base `310c7251c` and the corrected
working tree against the same saved 299-DPI source, 150-DPI canonical analysis
raster, production manifest, crop, and 2196x3241 canvas. Optical placement is
removed before component and pixel comparison (base x offset 218, corrected
209; both y 59). Evidence is in
`.devkit/analysis/s5-shear/canonical-routing/impressum-adjudication/`:
`forensics.json` is the machine-readable ledger and
`offender-neighborhoods.png` is the 14-pair visual crop sheet.

The table reports `ridge/local line median` in pixels. `n` is the population in
the 32-mm local line window. Base and corrected line numbers differ by five
because the corrected sparse page exposes five additional eligible line groups
above these rows; the affected physical line centers remain within 0.39 px, so
none is a line-cluster reassignment. Class `b` here means the candidate ridge is
unchanged or thinner while the local population median moves; the neighborhood
diff explicitly discloses that the full component bitmap is not byte-identical.

| # | corrected component bbox | class | base line: ridge/median (`n`) | corrected line: ridge/median (`n`) | neighborhood changed (`+ink/-ink`) | base / corrected source test (`out <= supported + 1`) |
| ---: | --- | :---: | --- | --- | ---: | --- |
| 1 | 744,1572 39x33 | a | L19: 4.000/4.000 (24) | L24: 4.394/2.000 (26) | 59 (+45/-14) | 4.000 <= 4.000 + 1 / 4.394 <= 4.000 + 1 |
| 2 | 808,1572 58x33 | b | L19: 4.000/4.000 (28) | L24: 4.000/2.000 (31) | 106 (+99/-7) | 4.000 > 2.000 + 1 / 4.000 <= 4.000 + 1 |
| 3 | 753,2055 14x29 | b | L25: 6.000/4.000 (25) | L30: 4.394/2.400 (29) | 58 (+0/-58) | 6.000 <= 6.000 + 1 / 4.394 <= 4.394 + 1 |
| 4 | 824,2061 11x23 | b | L25: 4.000/4.000 (28) | L30: 4.000/2.400 (33) | 60 (+0/-60) | 4.000 <= 4.000 + 1 / 4.000 <= 4.000 + 1 |
| 5 | 910,2056 33x29 | b | L25: 5.600/4.000 (30) | L30: 4.000/2.000 (35) | 180 (+0/-180) | 5.600 > 2.400 + 1 / 4.000 <= 4.000 + 1 |
| 6 | 1044,2053 23x32 | b | L25: 4.000/4.000 (27) | L30: 4.000/2.000 (32) | 35 (+0/-35) | 4.000 <= 4.000 + 1 / 4.000 <= 4.000 + 1 |
| 7 | 1159,2067 21x18 | b | L25: 4.000/4.000 (27) | L30: 4.000/2.400 (31) | 37 (+0/-37) | 4.000 <= 4.000 + 1 / 4.000 <= 4.000 + 1 |
| 8 | 1265,2056 33x29 | b | L25: 4.000/4.394 (28) | L30: 4.000/2.400 (31) | 65 (+0/-65) | 4.000 <= 4.000 + 1 / 4.000 <= 4.000 + 1 |
| 9 | 1139,2121 21x18 | b | L26: 4.000/4.000 (33) | L31: 4.000/2.400 (34) | 6 (+0/-6) | 4.000 <= 4.000 + 1 / 4.000 <= 4.000 + 1 |
| 10 | 1162,2120 15x19 | b | L26: 4.000/4.000 (33) | L31: 3.400/2.000 (35) | 24 (+0/-24) | 4.000 <= 4.000 + 1 / 3.400 <= 3.400 + 1 |
| 11 | 1221,2108 22x32 | b | L26: 4.000/4.000 (35) | L31: 4.000/2.000 (37) | 33 (+0/-33) | 4.000 <= 4.000 + 1 / 4.000 <= 4.000 + 1 |
| 12 | 1283,2119 14x20 | b | L26: 6.000/4.000 (34) | L31: 6.000/2.000 (36) | 1 (+0/-1) | 6.000 <= 6.000 + 1 / 6.000 <= 6.000 + 1 |
| 13 | 1338,2108 19x31 | b | L26: 4.000/4.000 (35) | L31: 3.400/2.000 (37) | 49 (+0/-49) | 4.000 <= 4.000 + 1 / 3.400 <= 3.400 + 1 |
| 14 | 1387,2119 5x18 | b | L26: 6.000/4.000 (34) | L31: 3.400/2.000 (36) | 68 (+0/-68) | 6.000 <= 6.000 + 1 / 3.400 <= 3.400 + 1 |

Classification is therefore **1 a / 13 b / 0 c**. Eight of the thirteen `b`
ridges retain the same ridge width and five are thinner. The lone `a` ridge
widens only 0.394 px and remains inside the source-relative +1 px tolerance.
The corrected source-relative verdict is 14/14 supported; the matched committed
base counterparts are 12/14 supported, and the two unsupported base components
become supported in the corrected output.

The separately recorded “base 3” is not the committed production replay. It is
the earlier 300-DPI `differential/runs/r2-force-layout` artifact with a different
canvas/context: two offenders on impressum and one on Vorwort. All three are
source-supported in both that run and their source-mapped corrected matches:

| leaf/component | class against corrected mapping | base line: ridge/median (`n`) | corrected line: ridge/median (`n`) | source-relative verdict |
| --- | --- | --- | --- | --- |
| impressum 531,2076 31x32 | non-a: materially thinner | L23: 10.000/6.000 (12) | L23: 4.800/5.800 (13) | supported / supported |
| impressum 1134,2238 16x33 | non-a: thinner, median stable | L26: 7.000/4.000 (28) | L26: 6.000/4.000 (35) | supported / supported |
| Vorwort 332,1340 30x39 | b: ridge stable, median moved | L12: 8.000/4.394 (9) | L11: 8.000/6.000 (8) | supported / supported |

This provenance distinction matters. The oracle README already documents that
the same measurement with different amounts of page context can produce counts
that are not directly comparable. Sparse pages amplify that limitation: a few
newly eligible or split components can halve a local median while the candidate
component is unchanged or thinner. The raw offender count is therefore not an
adequate acceptance criterion for this leaf without source and pixel evidence.

Full-canvas pixel diff is 275,475 pixels on impressum, inflated by the 9-px
optical placement shift. After intrinsic alignment, 40,927 pixels differ:
40,021 ink pixels are removed and only 906 added. Every offender neighborhood
intersects at least one changed pixel, but 13/14 ridges do not widen. Vorwort's
aligned diff is 63,890 pixels (59,638 removed, 4,252 added). Thus the corrected
build is globally thinner, not a hidden weight increase; visual crop inspection
shows intact text on all 14 neighborhoods.

On the combined evidence—13/14 non-widening median artifacts, 14/14 corrected
source support, globally reduced ink, and clean visual crops—the impressum leaf
passes adjudication despite the raw sparse-line count of 14. The rejected
experiments remain rejected: a blanket canonical-anchor bias worsened the raw
result, disabling Otsu fallback rescue did not change it, and a +24
threshold/thickness surrogate would recreate an undisclosed substitution.

## Parked-design disposition

The two preserved weight-program prototypes are dropped, not scheduled product
work.

- The integer three-pass shear prototype remains falsified by staircase jitter
  and its impressum regression. Its analysis is retained as historical evidence;
  the implementation patch has no residual production value.
- The renderer-faithful coverage-weight rescue gate remains technically viable
  but unnecessary. The landed routing and line-budget fixes leave no oracle
  offender class attributable to interpolation-halo rescue promotion, so a new
  gate and threshold would add policy surface without changing an accepted
  page. It should be reconsidered only if a future source-supported regression
  isolates that mechanism and supplies a new RED/GREEN adjudication.
