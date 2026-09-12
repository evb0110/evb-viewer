<!-- Provenance: copied verbatim from .devkit/analysis/weight-oracle/last.md (untracked working artifact), produced 2026-08-15. -->
<!-- Latest stroke-weight oracle adjudication summary (FAIL); the full REPORT.md remains untracked. Body unmodified. -->

# Stroke-weight oracle verdict (2026-08-15)

> The `Artifacts` links below are absolute paths on the VPS host that ran the oracle. They
> are recorded so the run can be identified, not resolved: none of those files is in this
> repository, and the oracle itself is not tracked yet: the ledger's R18 S5 supersedes
> R16 step 3 and retains this VPS job as S5(c) prototype evidence only. Everything below
> this note is the adjudication summary as written.

Verdict: **FAIL**. Candidate `70f0c70a` does not pass the red-calibrated stroke-weight gate.

| Tracked Luther p6–9 | Main | Candidate |
|---|---:|---:|
| Offenders | 277 | 281 |
| Red/measured leaves | 8/8 | 8/8 |
| Max p95/p50 | 2.000 | 2.000 |

| Leaf | Main offenders / ratio | Candidate offenders / ratio |
|---|---:|---:|
| 6L | 39 / 1.875 | 38 / 1.821 |
| 6R | 31 / 1.821 | 36 / 1.821 |
| 7L | 37 / 1.821 | 35 / 1.821 |
| 7R | 44 / 2.000 | 44 / 2.000 |
| 8L | 29 / 1.700 | 28 / 1.700 |
| 8R | 42 / 1.821 | 49 / 1.821 |
| 9L | 21 / 1.821 | 22 / 1.821 |
| 9R | 34 / 1.821 | 29 / 1.821 |

Vorwort calibration: main fails at 23/21 offenders; candidate worsens to 24/34. The clean 126R control is green on main with 0 offenders but becomes red on candidate with 2.

Fold metrics improve: raw `RESIDUE` leaves fall from 3 to 1. Actual fold exemplars improve from 7.79→0.17 mm and 24.38→2.54 mm. The remaining 118R result is the known picture-region false-positive.

Calibration constants: 32 mm horizontal radius, `>1.6×` local median, minimum 7 local components, 8 components per line, 8-connectivity, eligible height 12–70 px at 300 DPI.

Artifacts:

- [Full report](/home/ubuntu/rescue-research/weight-oracle/REPORT.md)
- [Oracle entry point](/home/ubuntu/rescue-research/weight-oracle/oracle/stroke-weight-oracle.mjs)
- [Distance-transform implementation](/home/ubuntu/rescue-research/weight-oracle/oracle/stroke_weight_oracle.py)
- [Diyarbakır in crop](/home/ubuntu/rescue-research/weight-oracle/crops/current-exact-final/diyarbakir-source-main-candidate-final-2x.png)
- [wahrscheinlich crop](/home/ubuntu/rescue-research/weight-oracle/crops/current-exact-final/wahrscheinlich-source-main-candidate-final-2x.png)
- [Ihm werden weder crop](/home/ubuntu/rescue-research/weight-oracle/crops/current-exact-final/ihm-werden-weder-source-main-candidate-final-2x.png)
- [Crop coordinate manifest](/home/ubuntu/rescue-research/weight-oracle/crops/current-exact-final/exact-final-crops.json)

All temporary build trees, caches, rendered fold images, failed-run evidence, and stale earlier-ref outputs were removed. No conversion children remain.
