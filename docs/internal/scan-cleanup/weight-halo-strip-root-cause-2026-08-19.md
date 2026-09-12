# Stroke-weight unevenness: root cause in the Wolf halo strip (2026-08-19)

Specimen: `003319_luther_syr_chronik_josua_styllites`, source spread 13, **right**
leaf (`p13-right`), Wolf route. The instrumented build reproduces the shipped
raster byte-for-byte, so every number below is ground truth rather than a model.

## What the defect actually is

Measured on 383 source/output word pairs across 38 body lines, using continuous
mean stroke thickness (ink area / skeleton length) and *within-line relative
weight* (word thickness / line median). Both are scale-invariant; relative weight
is also registration-independent.

| | tail (top 5%, n=19) | rest (n=358) |
|---|---:|---:|
| output within-line relative weight | **1.174** | 0.996 |
| source within-line relative weight | 1.020 | 0.998 |
| output / source ink area | 1.159 | 1.011 |

Dispersion of within-line relative weight: source **0.0441** → output **0.0632**,
an amplification of **1.43x**. The 19-word tail carries ~72% of the excess.

The discriminator every prior attempt lacked is in row two: the fattened words
are **not bold in the source** (1.020, indistinguishable from 0.998). This
separates "this component is over-inked" from "this line is genuinely heavier" —
the objection that sank the neighbour-relative p90 cap in `70f0c70ae`.

## Root cause

`rescue_component_scoped_faint_strokes_budgeted` contains two passes with
opposite polarity. On the Wolf route the first one — the halo strip — is *purely
subtractive*: it removed 227,962 pixels from this leaf and added none.

1. Wolf binarization sweeps in a gray halo. At that point weight is uniform:
   tail/rest thickness ratio **0.9993**.
2. The halo strip removes halo pixels, thinning text to ~4.73 px.
3. It only considers components admitted by `is_text_like_rescue_component`,
   which caps the component's **longest side** at 8 mm (94 px at 300 DPI).
4. The halo is exactly what fuses adjacent letters. A fused multi-letter blob
   exceeds 94 px, is classified "not text-like", and is skipped entirely — so it
   keeps its full Wolf halo.
5. Tail/rest ratio jumps 0.9996 → **1.1726** in that single step. Per-word ink
   removal: tail 10.8% vs rest 24.2%.

Of 1877 components on the leaf, **21 fail admission — 19 on the extent cap
alone**. They are one text line tall and several letters wide (126x41, 164x42,
115x39 ...), with average stroke 15.8–18.5, well inside the allowed 0.945–29.53.
Those 21 carry **50.6%** of the tail words' ink versus 1.7% of the rest's.

The loop is self-reinforcing: the pass is disabled precisely where it is most
needed.

## Why the previous attempts did not find it

- They tuned the **additive** rescue's gates and `RESCUE_ACCRETION_FRACTION_CAP`.
  On this leaf the additive rescue adds **zero** pixels; those gates are inert
  here. Everyone was working on the wrong side of the pipeline.
- Narrowing gates cannot reach it in principle: the defect is a component that is
  **never admitted at all**, not one that is admitted and then mis-scored.
- The tracked stroke-weight oracle cannot express the defect. It quantizes ridge
  width to a ~2 px lattice and flags at >1.6x a local median; a 1.17x excess is
  below its resolution. It reports 0 offenders on this page. The blobs are 95–164
  px wide, inside its 2–200 px census window, so this is an instrument-resolution
  gap, not a coverage gap.
- `bw.rs` notes that the production guard "deliberately uses the same component
  census, line grouping, 32 mm comparison population, and >1.6x decision
  boundary as the judge" — so the fix and its acceptance test shared one blind
  spot by construction.
- Preview-harness `wordWeights` uses a single **mean** run length per word, which
  arithmetically erases one bold letter inside a word, and tests preview-vs-final
  *agreement* rather than absolute unevenness.

## The change

`is_text_like_rescue_component` now takes a `RescueAdmission` mode. The additive
pass keeps the longest-side, aspect and area caps, because it can turn paper into
ink and must never see anything larger than a glyph. The halo strip bounds
**height** instead: it can only remove halo, so an extent cap buys no safety and
costs exactly the components that most need de-haloing. The stroke-thickness
bounds, the picture-owner guard, row alignment and the solid-core test are
unchanged, and the pass remains subtractive.

## Measured effect

Specimen leaf, same 377 matched word pairs:

| | before | after | source floor |
|---|---:|---:|---:|
| within-line relative-weight dispersion | 0.0632 | **0.0517** | 0.0441 |
| amplification over source | 1.43x | **1.17x** | 1.00x |
| worst word | 1.333 | **1.176** | — |
| tail/rest thickness ratio | 1.1724 | **1.0469** | — |

21 components changed; 100% of removed ink is in components wider than 94 px; no
component taller than 94 px was touched. The tail's 19 words lose 18–33% of their
ink — the rate their neighbours were already getting.

## Regression sweep

13 spreads / 26 leaves (includes the oracle's own `p6-9` calibration set),
baseline vs fixed binaries built from the same commit:

- 22 Otsu leaves: **bit-identical** output. The strip is inside
  `if selected_mode == BinarizationMode::Wolf`.
- 4 Wolf leaves (11R, 13R, 14R, 17R): dispersion improved on all four
  (0.0622→0.0569, 0.0632→0.0517, 0.0606→0.0481, 0.0701→0.0607). Tracked-oracle
  offender counts also fall (36→35, 24→23, 15→12, 28→22).
- **Zero** leaves worse; **zero** pixels added anywhere in the sweep.
- 11R shifts 1 px vertically (`placementOffsetYPx` 61→60) because de-haloing
  changed the ink bounding box and page alignment is ink-anchored. Expected
  consequence of `2c12ffec9` / `a493dd028`, not a defect.

## The behaviour pin that moved

`spread_preview_cli_pins_the_small_print_stroke_budget_outcome` in
`native/scan-cleanup/tests/page_cli.rs` covers the p5 impressum spread at 299 DPI,
where the right leaf resolves to Wolf (the same leaf resolves to Otsu at the
sweep's DPI, which is why the sweep did not surface it). Its updated expectation
is intentional and was verified directly rather than accepted:

- Right leaf ink 589,086 → 581,692 (−1.26%), with **added = 0, removed = 7,394**;
  leaf dimensions unchanged, so no alignment shift is involved.
- Left leaf output is **byte-identical**.
- Both leaves' `EVB_STROKE_BUDGET` traces are unchanged, including
  `rescueComponentsCapped: 0` and `rescuePixelsSuppressed: 0`. The stroke-budget
  adjudicator sees no new interventions; only halo left.
- Within-line relative-weight dispersion 0.1075 → 0.1059, and the measurable
  component count rises 1540 → 1565, because de-haloing separates blobs the halo
  had welded into one. The defect partly hid from measurement by fusing its own
  victims.

## Gray with no adjacent core is out of scope, by design

The strip removes a gray pixel only when it hugs a captured dark core. Gray that
touches no core — the material between two fused letters — survives. That is the
pass's remit, not an oversight: at this point such gray is indistinguishable from
a genuine faint hairline, serif or ligature, and `has_coherent_noncore_run` exists
precisely to protect those. A rule that deleted every non-core island would erase
real ink.

Measured on the five leaves this change touches, counting components of ≤4 px as
the artifact proxy: p13-right **+0**, p5-right **+0**, p11-right +2, p14-right +2,
p17-right +6, against baselines of 5–53. Every one of p17-right's six was
inspected: all are serif tips that separated from words which had been a single
fused blob (they split off base components of 1405–1825 px), and all are real ink
present in the source. None is leftover inter-letter gray. Total component counts
rise by 24–56 per leaf, which is the de-fusing itself.

Non-goals: this does not change the additive rescue, the oracle's calibration, or
any Otsu-route behaviour, and it does not claim to close the remaining
0.0517→0.0441 gap to the source floor.

## Follow-on that did not pay off: levelling to the line's own weight

Recorded here so the next attempt does not re-derive it. A sibling branch
(`fix/scan-cleanup-weight-uniformity`, forked from the same `a493dd028` as the
branch that became this document's change) kept going past the admission split
and was measured against `main` *after* that change had landed. It does not ship.

It made two further moves:

- **The strip decides per dark core, not per thresholded blob.** Halo is what
  fuses letters, so a thresholded component looked like an unstable unit of
  decision: a chance contact between two letters could exempt a whole word from a
  correction its neighbours received.
- **Oversized units are peeled, not skipped.** Units the glyph-extent bound
  rejects get their darkest halo pixels removed first, in at most three rounds,
  until their mean width reaches the local line's median. Width is measured as a
  mean over the chamfer field rather than the median ridge width, because ridge
  width is twice an integer chamfer distance and so quantizes to the 2 px lattice
  recorded above; a mean has no lattice, which is what makes a bound expressible
  as a *fraction* of a line's median rather than a multiple of it.

**Both were aimed at pre-change behaviour**, where an oversized fused blob failed
admission and kept its full Wolf halo. After the change, `HaloStrip` admission is
`height <= maximum_extent` and nothing else — there is no longest-side or area
cap, so no component is skipped for being a wide fused blob, and the cliff the
peel levels does not exist. Core-scoping is not voided the same way — it still
changes what the strip treats as one unit, and the measurement below attributes
6 px to exactly that — but the exemption it was written to prevent is now
reachable only by a blob that fuses vertically past 8 mm, and the difference it
makes there gives halo back rather than taking more.

Measured on `luther-p5-impressum-spread.png` at 299 DPI, the fixture behind
`spread_preview_cli_pins_the_small_print_stroke_budget_outcome`:

| | current | sibling branch |
|---|---:|---:|
| within-line relative-weight dispersion (320 matched word boxes, 29 lines) | 0.07671 | 0.07672 |
| worst word | 1.4899 | 1.4899 |

- Left leaf byte-identical. Right leaf **added = 133, removed = 0**: the branch
  removes nothing the current code does not, and keeps 133 px it strips.
- Four oversized units on the leaf. Three peel their entire qualifying ring
  (432/432, 347/347, 290/290) — identical to current behaviour. One converges at
  round 2 (mean width 5.5089 against a local line target of 5.5676) and stops with
  127 of 313 ring pixels unremoved. The other 6 px are one small mark whose ring
  differs under core-scoping; a control run with the peel forced to remove
  everything isolates them to the unit boundary, not the peel.
- Word boxes are taken once from the current output and applied to both rasters,
  so the pairs are matched and immune to de-fusing changing component counts.

The negative result is the useful part: **the peel can only ever remove less than
the current code**, because it stops at the line's median instead of taking the
whole ring. It cannot reduce over-boldness beyond what already ships; it can only
give back halo. Any future attempt on the residual 0.0517 -> 0.0441 gap has to
find ink the strip never reaches, not moderate what it already removes.
