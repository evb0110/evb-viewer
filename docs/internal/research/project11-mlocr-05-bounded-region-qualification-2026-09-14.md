# MLOCR-05 bounded-region qualification

Date: 2026-09-14

Disposition: reject adoption. Production OCR is unchanged.

This report records the qualification of bounded Tesseract region recognition for issue #809. The frozen MLOCR-03 policy requires at least a 10% relative faithful-CER reduction on the declared error-bearing target cohort, no language-cohort regression, no lost critical token, no added missing or duplicate line, no new order or PDF-fidelity defect, and clean-page p95 overhead no higher than 5%.

## Inputs

- Repository commit at qualification start: `72a87d298a948e05b17dd6288f4db8900e0b4676`.
- Frozen manifest definition: `ac15011508808c601323598f367c913dbe29b9aa958b887ef90ec458e9a5f2b7`.
- Tesseract: 5.3.4, Leptonica 1.82.0.
- Scan-cleanup binary SHA-256: `61289068b487b079a773f6cd72d021cd883bee8ebe1b79f78248dbaddbe6ce21`.
- Selected model hashes were the checked-in `tessdata_best` artifacts: `eng` `8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba`, `fra` `907743d98915c91a3906dfbf6e48b97598346698fe53aaa797e1a064ffcac913`, `rus` `b617eb6830ffabaaa795dd87ea7fd251adfe9cf0efe05eb9a2e8128b7728d6b6`, `ell` `288b4ea00bab450cf39893d22f04a2835a8469b673b5b20dcb39b159d1bbc9b8`, `ara` `ab9d157d8e38ca00e7e39c7d5363a5239e053f5b0dbdb3167dde9d8124335896`, `heb` `dbaa827aea6bc21215638447f17783a1004987c2d0bf5573d111fee397abdae5`, and `syr` `7642168b7731866d0ec4c74c67780913db4a04583874fcff0078daa8430bd887`. The benchmark staged the full 30-language registry from `resources/tesseract/tessdata`.

The required benchmark command was run without changing its inputs or thresholds:

```sh
pnpm run build:scan-cleanup
EVB_OCR_QUALITY_REQUIRED=1 EVB_OCR_QUALITY_DEGRADED=1 \
  EVB_SCAN_CLEANUP_PATH=$PWD/native/target/release/evb-scan-cleanup \
  node scripts/test-ocr-quality-corpus.mjs
```

MLOCR-02 completed for 120 pages and all 30 languages. MLOCR-03 completed for its 16 frozen profiles and 592 measured pages. The full JSON reports are the command output; the frozen mixed-language failures include `eng+rus+ell` at 0.2137 clean, `ara+heb+syr` at 0.1111 clean, and `ara+eng` at 0.0508 on `resample-150dpi`. Single-language cohorts remained within the frozen clean and moderate ceilings.

## Oracle-crop headroom

The manifest has no separate `crops` property. Its evaluator-owned mixed-page block polygons are the coherent regions used here. The raster and PSM 6 stayed fixed while the language set changed. PSM 7 was checked separately and was not used as an acceptance score.

The table reports faithful CER on the whole page, then aggregate CER over evaluator-owned crops with the full selected set and with the block's selected language only. The crop measurements are diagnostics, not production scores.

| Cohort | Full-page selected set | Crop, selected set | Crop, narrowed set | Crop reduction |
| --- | ---: | ---: | ---: | ---: |
| `eng+fra` same-script | 0.003571 | 0.003610 | 0.000000 | 100.0% |
| `eng+rus+ell` | 0.007874 | 0.007968 | 0.003984 | 50.0% |
| `ara+eng` | 0.033898 | 0.028736 | 0.028736 | 0.0% |
| `ara+heb+syr` | 0.055556 | 0.056911 | 0.032520 | 42.9% |
| `eng+rus+ell` columns | 0.423221 | 0.007605 | 0.003802 | 50.0% |
| `eng+fra` development columns | 0.214286 | 0.000000 | 0.000000 | 0.0% |

The crops show real headroom. Language narrowing helps Cyrillic, Greek and Syriac regions. Segmentation helps the columns cohort even when the selected language set remains unchanged. The multi-line column crops often returned one joined text line, so low CER alone does not prove line segmentation or saved-PDF fidelity.

## Automatic policies frozen for qualification

The development page `mixed-ambiguous-columns` froze two bounded candidates before automatic evaluation:

1. Policy A recognized Tesseract layout regions as crops with the full selected-language set and retained Tesseract's emitted order.
2. Policy B used the same image/Tesseract word-box regions, ordered overlapping columns left-to-right and top-to-bottom, and narrowed only when the detected script mapped to exactly one selected model. Same-script and uncertain regions retained every selected model.

Both policies kept a whole-page baseline, used at most 16 regions, and kept total crop area below one page area. No truth metadata selected a language or region.

Policy A failed on the development page itself. Its CER stayed at 0.214286 and it retained one reading-order failure. It therefore could not qualify for evaluation.

Policy B repaired the development page to CER 0 with no missing or duplicate line and no order failure. Its clean fixed-raster diagnostics improved `eng+rus+ell` from 0.007874 to 0.003937, `ara+heb+syr` from 0.055556 to 0.031746, and the columns cohort from 0.423221 to 0.003745. These numbers are diagnostic comparisons, not production acceptance scores. The same-script cohort did not improve, and its faithful critical-token check still missed the baseline token `417` in `417-A`.

## Policy C frozen before timing and evaluation

Policy C keeps Policy B's region recognition, ordering, and per-region language narrowing. It adds a gate based only on evidence already emitted by the mandatory whole-page baseline pass:

1. Run the whole-page baseline with the selected language set and retain its word boxes.
2. Build the same bounded word-box regions and apply the same overlap ordering as Policy B. Classify each region from its baseline word text using fixed Unicode script ranges for Latin, Cyrillic, Greek, Arabic, Hebrew, and Syriac. Digits, punctuation, whitespace, and other characters do not create a script label. A region with no recognized script or more than one recognized script is not usable evidence.
3. Take the baseline path with no crop recognition when the selected-language set has one entry, when no usable region exists, or when all usable regions have one script label. Enter Policy B's regional path only when at least two distinct script labels occur in usable baseline regions.

The gate is frozen before timing and quality results. It has no access to fixture truth, expected text, block language, crop polygons, or evaluation scores. A selected-language page with one script therefore pays zero additional recognition, including the `eng+fra` same-script page. When the gate fires, Policy C uses Policy B's maximum of 16 regions, page-area budget, ordering, and exact-one-model narrowing rule.

This definition was recorded in commit `feb6bc9b6` before the Policy C timing and quality commands ran.

## Policy B resource result

Policy B fails the hard clean-page overhead ceiling before production adoption. The production worker timing probe used the existing worker adapter and scan-cleanup preprocessing on `mixed-columns-and-notes`, followed by the nine crop recognitions required by the policy:

| Repeat | Whole-page baseline | Baseline plus crops | Relative overhead |
| ---: | ---: | ---: | ---: |
| 1 | 4550.6 ms | 8720.5 ms | 91.6% |
| 2 | 4388.9 ms | 8259.0 ms | 88.2% |
| 3 | 4648.5 ms | 8529.7 ms | 83.5% |

The observed p95 is 91.6%, above the frozen 5% tolerance. The timing result is conclusive, not an excuse to raise a timeout. Policy B is rejected. No automatic candidate passed the frozen adoption rule, so no worker, catalog, box, PDF, UI, or Electron changes were made.

Because this hard resource criterion fails on a controlled clean-page run, the remaining degraded automatic quality and saved-PDF acceptance stages were not run. A candidate that already exceeds the frozen clean-page budget cannot be adopted by a later quality result.

The remaining gap is a lower-cost production layout/recognition strategy that can preserve the measurable crop headroom without running the baseline plus several extra Tesseract recognitions. A new detector or a general reading-order subsystem would need a separate measured follow-up. This ticket does not add one.

## Policy C timing

The timing gate used three repeats over the evaluation-eligible `p2-v2` page for each of the 30 registered OCR languages. The mixed population contained all five evaluation-eligible mixed pages. Three pages fired the gate. The same-script page and the `eng+rus+ell` page remained in a separate non-firing mixed population and paid no crop cost. The p95 is the nearest-rank percentile over all page-repeat samples in each population.

The production adapter ran the mandatory whole-page baseline and scan-cleanup preprocessing. For a firing page, Policy C then ran the bounded crops from the baseline word boxes with the same Tesseract options and one worker-equivalent thread. Crop padding was 16 pixels. The maximum crop-area ratio was 0.0680, below the frozen one-page budget.

| Population | Pages x repeats | Baseline p50 | Baseline p95 | Added cost p50 | Added cost p95 | Relative overhead p50 | Relative overhead p95 | Gate result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Single-language clean | 30 x 3 = 90 | 4928.6 ms | 6130.3 ms | 0.0 ms | 0.0 ms | 0.0% | 0.0% | pass |
| Mixed-language clean, gate fires | 3 x 3 = 9 | 3127.5 ms | 3920.4 ms | 1287.8 ms | 2492.3 ms | 41.2% | 65.9% | tradeoff |
| Mixed-language clean, gate does not fire | 2 x 3 = 6 | 3091.5 ms | 3847.4 ms | 0.0 ms | 0.0 ms | 0.0% | 0.0% | baseline |

The clean-page population governed by the frozen 5% ceiling therefore passes at p95 with 0.0% additional overhead. The mixed-page cost is real and large. Policy C does not hide it. The firing pages used four regions for `mixed-rtl-ltr`, four for `mixed-rtl-scripts`, and nine for `mixed-columns-and-notes`. The non-firing pages were `mixed-same-script-latin` and `mixed-latin-cyrillic-greek`.

## Policy C quality result and rejection

Because the single-language overhead gate passed, the frozen mixed-cohort quality check ran once per evaluation page. The baseline and candidate used the same generated clean raster and production preprocessing. A non-firing page's candidate is its baseline by definition. The target cohort was the declared error-bearing `mixed-columns-and-notes` page.

| Cohort | Gate | Baseline faithful CER | Policy C faithful CER | Relative change | Baseline missing lines | Policy C missing lines | Policy C order failures | Policy C missing critical tokens |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `mixed-same-script-latin` | no | 0.000000 | 0.000000 | 0.0% | 0 | 0 | 0 | `417` |
| `mixed-latin-cyrillic-greek` | no | 0.015748 | 0.015748 | 0.0% | 0 | 0 | 0 | `208` |
| `mixed-rtl-ltr` | yes | 0.016949 | 0.000000 | 100.0% reduction | 0 | 0 | 0 | none |
| `mixed-rtl-scripts` | yes | 0.039683 | 0.039683 | 0.0% | 0 | 0 | 0 | none |
| `mixed-columns-and-notes` target | yes | 0.415730 | 0.419476 | 0.9% worse | 4 | 0 | 4 | `3` |

Policy C is rejected under the frozen adoption rule. The same-script cohort still loses the critical token `417` from `417-A`, so the no-lost-critical-token condition fails on its own. The target cohort also fails the required 10% relative faithful-CER reduction, gets worse by 0.9%, and adds four reading-order failures. The candidate improved the target's line matching, but that does not waive the order or CER conditions. The `mixed-rtl-scripts` cohort has no quality gain, and the `mixed-latin-cyrillic-greek` cohort remains at its baseline error level.

No production worker, transcript/catalog/box merger, PDF assembler, UI, or Electron changes were made. The saved-PDF, search, copy, save/reopen proof was not run because Policy C failed the frozen raw mixed-cohort rule before integration. Disposition remains reject adoption.
