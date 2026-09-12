# Stroke-weight unevenness: root cause in the rule restore (2026-08-19)

Companion to `weight-halo-strip-root-cause-2026-08-19.md`. That fix addressed a
*Wolf-route* mechanism. This one is route-independent and runs after
binarization, so it survived every earlier attempt untouched.

Specimens, both from `003319_luther_syr_chronik_josua_styllites`:

- source spread 39, **left** leaf, **Otsu** route — footnote 204 prints bolder
  than footnotes 203 and 205;
- source spread 152 (Register), both leaves, **Wolf** route — index page numbers
  that are *not* bold in the print are rendered bold, next to page numbers that
  genuinely are.

## Attribution

The pipeline was dumped stage by stage on spread 39's left leaf and each stage
measured with mean stroke thickness (ink area / skeleton length), normalised to
the median of the ten-line footnote block. Relative weight of footnote 204:

| stage | line 204 | block dispersion |
|---|---:|---:|
| raw global threshold (t=127) | 1.000 | 0.077 |
| after thresholding | 1.032 | 0.111 |
| after the line stroke budget | 1.032 | 0.111 |
| after despeckle + smoothing | 1.032 | 0.115 |
| after the faint-ink rescue | 1.032 | 0.115 |
| **after `restore_genuine_horizontal_rules`** | **1.139** | **0.198** |

Binarization is exonerated: at the threshold the line sits exactly at the block
median. The binarization output (`stage 5`) is a *pixel-exact subset* of the
shipped raster, and the 2,070 pixels that separate them are contributed entirely
by the rule restore — of which **1,579 land on footnote 204 alone** and zero on
any other line of the block.

The same probe explains why `normalizeIllumination: false` appeared to "fix"
line 204 in earlier experiments. It does not change the binarization at all
(both settings threshold bit-identically). It changes the text masks, which
causes the rule restore to accept *ten* lines instead of one — spreading the
damage until 204 no longer stands out. Dispersion actually rises, 0.198 → 0.240.

## Root cause

`restore_genuine_horizontal_rules` exists to recover printed rules that
threshold into dashes. Because a scanned rule is broken, candidacy is measured
on a map bridged horizontally by ~1.5 mm (18 px at 300 DPI) before components
are cut. That bridge also fuses the glyphs of an ordinary text line into a
single long blob.

The admission test was

```rust
width >= minimum_span                                   // 15 mm
    && width >= height * 4
    && height <= maximum_thickness                      // 4 mm
    && (height <= thin_thickness || width >= height * 8) // 2 mm, or long
    && component.area >= width
```

The last clause is the defect: a component thicker than 2 mm is still admitted
if it is merely long. After bridging, *every* text line is long. Accepted
components are then re-inked at `raw <= paper - RULE_RAW_DEPTH` (181 on this
scan) rather than the page's binarization anchor (127) — a second, far more
permissive binarizer applied to one line. The line survives at a heavier weight
than its neighbours, which is exactly the reported artefact.

Measured on the two specimens, thickness separates the two populations cleanly:

| | height |
|---|---|
| genuine rules accepted | 7 px, 9 px |
| text lines wrongly accepted | 31–47 px |

Coverage does not separate (genuine rules are 0.852–0.856 already-covered, text
lines 0.78–0.97), and neither does bounding-box density with adequate margin.
Thickness is the only property that survives the bridge.

## Fix

Aspect ratio can no longer substitute for thinness; the 2 mm bound decides
admission alone. Nothing else changes: acceptance still requires a text row
above, the text-overlap veto is unchanged, and restored pixels remain an exact
subset of the raw-dark support.

## Verification

- Spread 39 left leaf (Otsu): footnote 204 relative weight 1.139 → **1.032**;
  block dispersion 0.198 → **0.115** (−42%), stddev 0.0537 → 0.0348. The only
  changed band on the leaf is the 46 px text line. The genuine 9 px footnote
  separator rule is **bit-identical**, still fully restored.
- The output is now **identical** with `normalizeIllumination` on and off, so
  line weight no longer depends on that setting.
- Spread 152 (Wolf, both leaves): four spurious re-inkings removed, nothing
  added. The worst index run drops from 1.504x its own line to 1.190x, the
  residual being the page numbers that are genuinely bold in the print — those
  are preserved.
- `page_cli.rs` impressum pin: left leaf 187,731 → 182,427 px, right leaf
  581,692 → 581,428. All six changed bands are 33–45 px tall text lines,
  including the full-width body line "außerhalb der engen Grenzen …" and the
  "2. Timotheus 4,5:" run. No band thinner than the 2 mm bound changed.

## Non-goals

The restore still uses a depth threshold different from the page anchor. That is
correct for a genuine rule, which is why the fix tightens *what counts as a
rule* rather than changing how an accepted rule is re-inked.
