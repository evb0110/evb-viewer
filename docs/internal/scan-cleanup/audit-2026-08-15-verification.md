<!-- Provenance: copied verbatim from .devkit/analysis/branch-audit-2026-08-15/VERIFICATION.md (untracked working artifact), produced 2026-08-15. -->
<!-- Verification pass behind the 2026-08-15 corrective audit. Its companions are tracked beside it: REPORT.txt as audit-2026-08-15-corrective.md, CORRECTIONS.md as audit-2026-08-15-corrections.md, vps-verification.md as audit-2026-08-15-vps-verdicts.md. Body unmodified. -->

# Adversarial verification of `REPORT.txt`

Verified source: `.devkit/analysis/branch-audit-2026-08-15/REPORT.txt`  
Historical main object: `6ce2f0b619cd4cc35931f2e220585a7a9f2af1a1` (`A`)  
Post-correction rescue object: `70f0c70ae8c1e1f2b7f0d4fce7fc19222de9536e` (`R`)  
Report timestamp: `2026-08-15T01:20:50+04:00`  
Mode: read-only repository/GitHub investigation; no remediation was performed by this audit.

## Executive verdict

`REPORT.txt` is unusually strong on raw counts, SHAs, line locations, PR history, and the existence of real governance/coverage/CI gaps. It is not safe to adopt as a literal defect-and-execution plan. Several behavioral headlines are stronger than their evidence, and several proposed fixes would either do nothing or remove valid coverage.

The most consequential corrections are:

1. **2.3 is wrong as a behavioral conclusion.** A fresh exact-`A` full harness run passed with total `51`, split `51/51`, `contentLostOutsideCrop=0`, and every catastrophe counter zero. The H50 baseline is stale, denominator-blind, and unwired; that does not make PR #11's result false.
2. **C2/3.2 overstates the rescue defect.** `R` has a post-union clamp, but `source_exclusion` is also fed upstream into artifact subtraction, picture qualification, rescue cleaning, and the `analysis_picture_mask` consumed by the union.
3. **1.9's proposed partial trim cannot work as stated.** If a protected block remains on the same extreme, recomputed bounds do not move and trim thickness is zero. This invalidates S4's strict 1.9-before-1.1 dependency.
4. **1.5/S3(d)'s zero-execution repair would select zero new files.** Adding roots is insufficient because `isZeroExecutionTripwireTarget()` rejects every core/adapter path.
5. **1.4 is a retry/idempotency defect, not an ordinary reconnect-permanently-leaks story.** Normal navigation clears subscribers before restored-session reconnect.
6. **1.7's proposed version/protocol smoke cannot detect a pre-PR-17 sidecar.** PR #17 added optional fields without bumping public manifest v3 or packaged runtime compatibility protocol 6.
7. **1.10 is path- and size-dependent.** Auto Sauvola is unreachable for common large positive-run inputs routed in full/working resolution, not only reachable at scale 1; capped production samples can yield 3.0.
8. **1.11 reverses the safety axis.** Leaves meeting at the cutter remove the least source material: conservative for content retention, weak for fold suppression.
9. **1.13's action does not meet its DONE claim.** Explicit options prevent default drift, but shared algorithm/constant/rescue changes can still alter OCR pixels.
10. **3.5 is false.** On `R`, `rescue_component_scoped_faint_strokes` has a non-test call at `bw.rs:436`.
11. **4.2's “no Python lane” premise is false.** CI already installs Pillow in multiple jobs.
12. **S6 is unsafe.** The manual native job uniquely runs clippy and cargo-deny; quarantine tests are policy pins, not dead code.
13. **4.7 is false as written.** Lossless preview cannot prove export placement, but the actual exported PDF can be rendered and inspected today.
14. **The universal closure reminder is ill-typed.** Export RED→GREEN does not apply to ledger edits, branch protection, hygiene, deletion, branch cleanup, or support-policy declarations.

## Method and confidence

Fourteen local GPT-5.6-sol reviewers independently covered code paths, Git/GitHub history, quantitative claims, governance, release verification, operational state, and the derived plan. High-risk geometry and whole-report claims received overlapping hostile reviews. A separate GPT-5.6-sol VPS thread ran in an isolated detached worktree at `A`. Disagreements were resolved against immutable Git objects, live read-only GitHub APIs, full caller/state tracing, focused tests, or fresh corpus execution.

The companion VPS evidence file is `vps-verification.md`: 618 lines, 240 atomic verdict rows (91 verified, 83 partial, 26 false, 12 stale-now, 28 unverifiable) across all 61 required identifier groups. This file is the reconciled synthesis; the companion preserves the more granular independent trail.

Hygiene disclosure: one VPS reviewer invoked the writing form of `git merge-tree`, which created one tiny unreachable tree object (`e247407c…`) in the remote shared Git object database. It changed no ref, branch, HEAD, index, worktree, or reachable commit. The conclusion was rechecked with the nonwriting form. No garbage collection was run because deleting shared objects was outside scope. The VPS worktree was cleanly removed, disposable harness/build directories were deleted, and no audit process was left running; an unrelated pre-existing `weight-oracle` VPS job was left untouched.

Fresh catastrophe run at exact `A`:

```sh
cargo run --release --manifest-path native/Cargo.toml --locked \
  -p evb-scan-cleanup --bin scan-cleanup-harness -- \
  --out /tmp/evb-catastrophe-audit-6ce2f0b61 \
  --baseline native/scan-cleanup/harness-baseline.json
```

Result: exit `0`, total `51`, split `51/51`, all catastrophe counters `0`; report JSON SHA-256 `3c836394c1b79e4c05cd0c2aaac5e846b963d99c5c5bae854d18c9265b9e04f5`.

Other checks: subscription tests 3 files/42 passed; generated-output/open-path/coordinator/OCR TS tests 4 files/41 passed; native OCR integration 1 passed. Rescue artifacts prove exact `R` compiled into a release test target containing its nine added tests, but no preserved evidence proves those tests executed.

Verdicts: **VERIFIED** means the precise premise reproduced; **PARTIAL** means factual core but wrong/unproved scope, causality, severity, action, or DONE condition; **FALSE/UNSAFE** means materially contradicted; **STALE NOW** means snapshot-true but superseded; **UNVERIFIABLE** means not reconstructible.

## Snapshot corrections and C1-C5

| ID | Verdict | Verification |
|---|---|---|
| Baseline main/four commits | **VERIFIED at snapshot; STALE NOW** | `A` is four commits after `5dd17ff9e`: `32b50f2c7`, `5bb06b395`, `77095bead`, `6ce2f0b61`. Main/origin advanced during verification to `1883e0752`. |
| Baseline PR #17/run | **VERIFIED at snapshot; STALE NOW** | PR #17 merged `20:55:41Z` as `A`. Run `31840148788` was active at report time, then completed success at `21:24:01Z`; exact-SHA attestation now exists. |
| Baseline worktrees | **VERIFIED historically; STALE NOW** | Retained metadata supports “truth removed, rescue only.” Leak/oracle/ownership worktrees were created after the report; five now exist. |
| Baseline R16 steps | **PARTIAL** | Steps 0 and raster step 1 landed. Step 2 was not wholly absent: its preview-harness composition subtask also landed in `32b50f2c7`. Lossless step 1 and remaining wiring stayed open. |
| Baseline `rg` corruption | **UNVERIFIABLE** | No durable corrupted-output sample survives. |
| C1 | **VERIFIED** | `R` is clean/pushed. Second delta is five files `+491/-120`; “491 dirty lines” means inserted lines, not total churn. 3.1/S0(a) resolved. |
| C2 | **PARTIAL** | Union `R:content.rs:583-599`; clamp `:601-616`, writes `:609-612`. It is a later side owner and ignores accepted trims. But exclusion also feeds upstream at `:357`, `:377-380`, `:385-452`; “instead of feeding owners/reproduces RC2” is false. |
| C3 | **VERIFIED at snapshot; STALE NOW** | `A...R = 5 behind / 2 ahead`; merge-base `76a4cc976`. Current main makes it `6 / 2`. |
| C4 | **VERIFIED at report time; STALE NOW** | Run success arrived 3m11s after report timestamp; steps 0/1 are now attested. |
| C5 | **VERIFIED at snapshot; partly stale** | Code/baseline/protection/weight-path/session/branch facts corroborated. Session crossed report time, then ended after renderer/GPU crash and wrapper exit—not evidenced `stop`. `.rows` and sessions are now gone; refs/worktrees/main changed. |

## Section 1: code and repository findings

| ID | Verdict | Verification and correction |
|---|---|---|
| 1.1 | **PARTIAL** | Outward picture union after trim is real and cannot see trim state. It can re-expand an accepted side. It does not prove causation for twelve landings; structured-edge authority at `:357-365` is another post-trim expansion; a test intentionally pins full picture extent. Reconcile authority semantics and use the post-trim/pre-union bound. |
| 1.2 | **PARTIAL** | H50 baseline is stale vs live H51; comparator ignores denominators; no automated `--baseline` caller. Four counter units represent three distinct failing fixtures. Harness does observe the pipeline; comparator test includes a real mutation check. Fresh `A` is already zero/51-of-51. Regenerate/harden/wire without behavior changes. Generated wrapper vs bare baseline format also needs an explicit generation/extraction path. |
| 1.3 | **PARTIAL** | No required quality aggregate; required attribution only, strict off, admins exempt, force push on, conversations off, no PR requirement/rulesets. Attribution is meaningful, so “guarantees nothing” overstates. Aggregate is exactly `gates_ok`, not `Quality Gates`. Universal non-mergeability also needs bypass/admin/PR/exact-final-SHA semantics. |
| 1.4 | **PARTIAL** | Duplicate/retried service subscriptions add fresh closures and lose handles; `32b50f2c7` removed only eager start registrations. Normal navigation clears the Set before reconnect; records clear at disposal; reconciliation normally stops on first success. Correct headline: duplicate/retry idempotency gap. |
| 1.5 | **PARTIAL; action false** | Omission and 30 files/10,384 physical lines are exact (9,373 code). Roots alone add zero targets because predicate rejects all paths; tripwire does not read `coverage.include`. Coordinate coverage globs, roots, predicate/list, explicit area, PR guard, and debt rollout. V8 denominator is not physical LOC. |
| 1.6 | **PARTIAL** | Temp UUID/7-day directory-mtime/Recent exclusion/Save As premises hold. Active/restored working copies are skipped; first save is forced Save As; durable Save As enters Recents. Risk is orphaned/closed/discarded or failed-open output, not an active restored tab. Define unsaved vs recoverable-draft semantics before touching/Recents. |
| 1.7 | **PARTIAL; DONE false** | Only mac runs scan-cleanup CLI/version/protocol; Linux/Windows omit CLI/protocol behavior evidence; policy only drives mac helper; win-arm64 is a gap. `ldd` is static/loader evidence. Same-version stale binary still passes because PR #17 bumped neither runtime protocol 6 nor manifest v3. Need functional emitted-metadata smoke or build identity/version change. |
| 1.8 | **PARTIAL** | Native tests/host clippy run only x86_64 Linux on PR/push; four shipped platform-arches lack test execution. “All Rust validation one triple” ignores wasm compile, five-leg release builds, fmt, cargo-deny. ARM is partial remediation only. |
| 1.9 | **PARTIAL; action false** | One validated text boolean or one picture pixel anywhere in block bbox protects a block; a protected side-touching extreme vetoes proposals. Scope is touched side. Retaining that protected extreme leaves bounds unchanged and thickness zero, so removing only unprotected co-touching blocks cannot advance crop. Fix false protection, split/reclassify geometry, or use another representation. |
| 1.10 | **PARTIAL** | Large positive-run full/working-resolution inputs exceed width 8, making Auto Sauvola unreachable on those paths. Scales above 1 can pass up to 8, zero-run can pass, explicit Sauvola bypasses Auto, and capped production routing can measure 3.0. Record actual export-path distributions, not only harness route. |
| 1.11 | **PARTIAL** | Two Options conflate multiple states and diagnostics lacks reason. Abstention emits single page, not two-leaf fallback. Meeting at cutter is safest for content retention, weakest for fold suppression. Model measured band, measured-no-shadow, inconclusive/invalidated, and not-applicable; propagate to all consumers/codecs. Nominal destructive fallback needs content-loss proof. |
| 1.12 | **VERIFIED as evidence gap** | Preview derives pixel placement; lossless export independently derives point-space `placeUniformBox`; no cross-path identity oracle. This does not prove observed mismatch. A table boolean alone is insufficient; compare actual lossless export geometry/render. |
| 1.13 | **PARTIAL; action insufficient** | Clean OCR inherits default Auto/normalization/despeckle/BW; shared algorithm changes can alter its pixels. Native geometry/atomic tests exist; pixel/recognition oracle does not. Explicit options isolate default drift only. Versioned OCR profile/route plus goldens/recognition corpus is needed for stated isolation. |
| 1.14 | **PARTIAL/mixed** | Final-render `match_page_sizes` half is unreachable. Quarantine tests/schema deliberately pin policy. O6 inventories 169 named f32/f64 declarations (rescue 172), not a strict budget. Quarantine assertions are not dead code; deleting them changes no workflow. `~3380` is incomparable/undefined. 168→169 was legitimate paired regeneration, not bypass proof. |
| 1.15 | **PARTIAL** | No CI packaged scan-cleanup conversion. There are local indirect callers; verifier is also macOS and Developer-ID gated. Wiring must happen after/on mac packaging with a committed/default fixture/config; Ubuntu step skips it. Not a general entitlement oracle. |
| 1.16 | **VERIFIED at snapshot; STALE NOW** | Logs prove default session `20:26:09`–`01:24:38`; rule/script contradiction and 12 crash reports hold. RSS was ephemeral. Current checks are empty after crash/exit, not evidenced prescribed stop. Closed `.ips` burst did not prove later session health. |
| 1.17 | **PARTIAL** | Historical 8.5G is consistent with current 8.2G plus removed session; named leaves reproduce. Say gitignored/mixed-recoverability, not unrecoverable. More than 288K is cited. Classify/promote evidence before prune and define numeric cap. |
| 1.18 | **VERIFIED at snapshot; STALE NOW** | Twelve merged heads, rebase metadata authority, zero preview-truth tree diff, and parked refs hold. “Genuinely in-flight” is not mechanical; categorize merged/active/parked/unadjudicated. New branch/PR/worktrees appeared and `.rows` disappeared. Destructive deletion requires explicit disposition. |

## Section 2: false/stale governance claims

| ID | Verdict | Verification and correction |
|---|---|---|
| 2.1 | **PARTIAL at `A`; STALE NOW** | Ledger was four commits behind, had no R17, left steps 0/1 pending, used obsolete refs, and omitted #13/#14/#16/#17. Step 0 and raster step 1 landed; placement-harness subtask also landed. `placement.ts` was 161 lines, not 185, before becoming 77. Lossless was never closed. Run is now successful; `1883e0752` reconciled the ledger. |
| 2.2 | **VERIFIED at `A`; STALE NOW** | S2 DONE contradicted R11/R13/R16 and used an invalid word-mean closure. Rescue was candidate, not accepted “actual fix.” C1 superseded dirty-files state; `1883e0752` now reopens/records it. |
| 2.3 | **FALSE headline; governance debt verified** | Baseline is stale and “mechanical” is false; PR merge text was stale. Fresh exact-`A` execution proves PR #11's zero/51-of-51 behavior. Keep S3 product outcome done/attested; keep baseline regeneration, denominator equality, and CI wiring open. |
| 2.4 | **VERIFIED with wording correction** | S2/S3 close was authored 56s after PR #10 merge and 29m06 before PR #11 merge, breaching G3. They were not the first ledger closures; S1 preceded them. State author/commit/push clock explicitly. |
| 2.5 | **PARTIAL** | Preview harness has no automated executing caller and should be `manual`; stay-fixed 0/3 is hand-adjudicated with no computation/cadence. Harness has many textual/doc refs, not only the key-existence test. Headline conflates one false gate label with one uncomputed metric. |
| 2.6 | **PARTIAL** | All 19 ledger-changing commits after PR #6 through `5dd17ff9e` lack associated PRs. Direct commits remain tracked/clone-visible; they specifically bypass PR/CodeRabbit review. Docs do not literally say every governance edit must use PR. Clarify policy. |
| 2.7 | **PARTIAL** | PR #17 overclaims retry idempotency, which was untouched; it correctly removed ordinary eager start-side double delivery. Normal navigation reconnect already clears subscribers. Correct record to both facts. |
| 2.8 | **PARTIAL** | PR #17 has no referenced eyeball pack; body 4,010 chars; one top-level CodeRabbit issue comment. Chat unavailable. PR #12 does reference ignored before/after/video directories, contrary to “likewise none,” though not a durable accessible pack. |
| 2.9 | **PARTIAL** | Merge timestamps/mapping and formal open batch hold; per-item status/evidence basis missing. “Ledger records none” is false: #15 and ETA had entries. Export RED→GREEN is not natural for ETA/IPC and may not fit display-only phase-edge; state evidence class per symptom. |
| 2.10 | **PARTIAL** | Central S2/S3/S5/weight measurements are non-portable and no tracked component oracle exists. “Every cited closure number” is false; 169/corpus/history values reproduce. Ledger rule cited forbids speculative `.devkit`, not all final local evidence. “SYNTHESIS section 7/8” is impossible. |
| 2.11 | **VERIFIED** | Binding Design/OCR/UI/Native-CI rules were in ignored `CLAUDE.md`; tracked architecture audit lacks them; CodeRabbit paths reference no charter. Track charter and reference it. |
| 2.12 | **PARTIAL** | X2 “2 commits” is stale vs configured 10. Q1 is an imperative plan explicitly admitting current nonblocking/30 pins; its “is retired” grammar is awkward, not a simple false present-state report. |
| 2.13 | **VERIFIED at `A`; STALE NOW** | SYNTHESIS has sections 1-7; numbered 8 is deletions; boundary findings are in `COMPLETENESS-CRITIC.md`. “Probably how” is unproved. Later reconciliation repointed it. |

## Section 3: rescue branch

| ID | Verdict | Verification and correction |
|---|---|---|
| 3.1 | **STALE/RESOLVED** | Historical five-file WIP is now `R`, clean/pushed. Exact `+491/-120`; not all named substance was solely in dirty half. S0(a) done. |
| 3.2 | **FALSE as headline; structural concern real** | Post-union clamp and general accepted-trim/picture-union conflict are real. Exclusion also feeds upstream and changes union input. Clamp contracts while RC2 expands. Call it an additional unrecorded side owner/defensive postcondition; do not claim “instead of owners” or same failure absent specimen. |
| 3.3 | **PARTIAL** | Snapshot base/divergence/governance prerequisites hold; both sides touched `render.rs`. `git merge-tree` auto-merges current tips, so “conflict pending” is unsupported. Ledger already recorded weight/ownership blockers; only commit message failed. `1883e0752` now freezes branch. |
| 3.4 | **PARTIAL** | Absolute-output oracle absent; word mean/preview-final deviation cannot reject equally uneven export. Four earlier family landings exist. `874` is sequential churn (489+385), not final delta; merge-base-to-`R` is `+753/-3` = 756 touched. Rescue is fifth attempt, not fifth main landing. |
| 3.5 | **FALSE** | Wrapper delegates, but `R:bw.rs:436` is non-test call in `binarize_with_mode`; ordinary clean/harness production paths reach it. App rendered paths use excluding variant, which is narrower. Test line citations are wrong. Exact `R` compiled into test target; execution/pass unpreserved. |

## Section 4: forward-plan claims

| ID | Verdict | Verification and correction |
|---|---|---|
| 4.1 | **PARTIAL** | Pre-push cannot be required remote enforcement; aggregate is `gates_ok`, not `Quality Gates`. Hook still has blocking-local value. Ledger R5 declined GitHub settings changes; report cannot reverse that authorization. Stage proven-green checks before requiring; decide admin/bypass/PR/strict/exact-final-SHA semantics. |
| 4.2 | **FALSE premise; oracle gap real** | Component oracle is ignored/unparameterized. CI already installs Pillow/runs tracked Python, so porting is not prerequisite. Track/refactor runner and reproducible inputs; rescue PNGs are line crops, not pre-fix bad export. |
| 4.3 | **FALSE dependency/order** | Mixed rescue commits should split; fold subset follows authority semantics. Weight and geometry are independent. 1.9-before-1.1 is backwards/unproved and proposed 1.9 cannot move side. Fix/pin union authority first or land coherent atomic geometry change. |
| 4.4 | **PARTIAL** | No enforcing export word-loss gate; old S5/S6 residues orphaned; report's 12 scheduled failures true (max streak 15). R16 did include native content loss among catastrophe zeros, so not whole class omitted. Nightly can invoke word-loss nonblocking with `--fail-on none`/optional inputs. Wiring needs tracked fixture and real fail semantics. |
| 4.5 | **PARTIAL** | Approach and R16 conflict. R16/SYNTHESIS do contain deletion disposition; older approach was unreconciled. Delete or formally supersede, but do not cite legitimate 168→169 regeneration as self-blessing. |
| 4.6 | **PARTIAL** | Stay-fixed lacks fields/cadence/computation. SYNTHESIS asserts 0/3 but does not define eligibility, denominator, taxonomy, window. R1-R15 are not all closures. Define/instrument eligible events or delete metric. |
| 4.7 | **FALSE as written** | Lossless preview cannot be export-placement evidence without parity. Direct rendering/inspection of actual export satisfies criterion now. Unification enables preview proxy evidence, not direct-export closure. |
| 4.8 | **PARTIAL** | PR #17 bundled steps 0/1 and violated one-step-one-PR. R15 governs consolidated user reporting, not PR bundling; no genuine precedence conflict. Record violation or one-off waiver. |
| 4.9 | **PARTIAL** | Supported class absent; route distribution relevant. Class must provisionally define corpus/inputs before tuning/distribution; deriving only from current corpus is circular. Define formats, DPI/range, topology, output/lossless, degradations/fallback, corpus, success, then refine. |

## Corrected sequence S0-S8 and closure reminder

| Step | Verdict | Required correction |
|---|---|---|
| S0 | **STALE/PARTIAL** | Rescue durability and `.rows` absence done. Session gone after crash, not evidenced stop. Hygiene urgent but not global dependency for all parallel code. |
| S1 | **PARTIAL** | Concise reconciliation useful and `1883e0752` exists. Do not retrofit stay-fixed to non-closure rows. It promised reproducibility while deferring tracked evidence/scripts to S7. |
| S2 | **PARTIAL / authorization conflict** | Exact `gates_ok`; hook stays blocking-local. Existing R5 permits only advisory/visible-red record absent explicit reversal. Stage green checks before protection; decide admin, PR-only, strict base, exact final SHA. |
| S3 | **PARTIAL** | Regenerate H51 zero baseline behavior-free; exact corpus/category equality; retain mutation test; add fresh evaluation/CI and tracked fixtures. Coverage needs three selectors plus rollout. Distinguish hard-zero native counters, word-loss reliability/fail modes, named exceptions. |
| S4 | **FALSE/UNSAFE as ordered** | Define/pin final side authority/diagnostics; include structured-edge and picture writes. Reject simple partial removal with protected extreme. Typed fold outcomes need all consumers/codecs and two safety axes. Split rescue topics; do not delete clamp without equivalence. |
| S5 | **PARTIAL / internally contradictory** | Diagnose/instrument routing before oracle, but behavior-changing Sauvola unit fix violates “no bw acceptance before oracle.” OCR isolation needs behavioral profile. Track/wire component oracle with pre-fix export fixture, then adjudicate bw subset only. |
| S6 | **FALSE/UNSAFE** | Delete proven unreachable final branches. Do not delete quarantine pins without coordinated policy/schema/workflow. Do not delete manual native job unless clippy/deny move. Reconcile O6 on actual scope. |
| S7 | **PARTIAL / overbundled** | Seven unrelated tracks need separate evidence/authority: output semantics, functional smoke, charter/evidence, mac post-package conversion, lossless parity, pruning, branches. Branch deletion/pruning are destructive and need exact targets. |
| S8 | **PARTIAL** | Define provisional class before selecting gates/corpus; finalize after actual export-path routing distribution. |
| Universal closure reminder | **FALSE** | Export RED→GREEN for user-visible output defects (or proven-equivalent/downscaled preview); negative probe for oracles; preservation/caller proof for refactor; consistency for governance; exact postcondition for hygiene; explicit scope for support policy. |

## Adversarial disagreement resolution

1. **S3 behavior versus stale baseline:** static review called 2.3 unproved. Fresh exact-SHA execution resolved it: runtime zero/51-of-51 is true; baseline/enforcement debt remains.
2. **Rescue clamp:** syntax-only review called it appended RC2. Full data flow proved upstream exclusion feeds analysis mask/other owners. Verdict: multiple ownership/diagnostic risk, not demonstrated behavioral reproduction.
3. **Reconnect leak:** closure storage showed non-idempotency; lifecycle review proved ordinary navigation clears first. Verdict distinguishes retries/duplicates from normal restored reconnect.
4. **Wrapper callers:** superficial scan treated remaining calls as tests; non-`cfg(test)` trace at `R:bw.rs:436` falsified 3.5.
5. **Protocol numbers:** public manifest remains v3; packaged runtime compatibility is 6. Release `--protocol-version` prints Rust compatibility 6. Neither bumped for PR #17 optional fields, so version smoke misses same-version stale sidecar.
6. **Q1:** “is retired” reads present tense, but item is imperative and admits current pins. Verdict: ambiguous/stale intent, not simple false present-state statement.
7. **1.9 ordering:** two independent geometry reviews agreed that keeping protected extreme yields zero thickness. The proposed remedy/order was rejected.

## Reproduced quantitative and GitHub claims

- Live split manifest: 34 = hard 10 + spread 19 + Luther 5.
- Baseline: split 33, Luther 4, total 50, real 36, synthetic 14; live total 51.
- Baseline counters: content loss 2, classification 1, offcut 1; four counter units but three distinct fixtures.
- TypeScript: 30 physical files, 10,384 lines; CLOC code 9,373.
- Build matrix: mac-arm64, linux-x64, linux-arm64, win-x64, win-arm64.
- O6: main 169, rescue 172. `~3380` is approximate/incommensurate lexical population.
- `.devkit`: current about 8.2G; historical 8.5G consistent with removed session.
- Crash reports: 12; latest two `EXC_CRASH`/`SIGABRT`, responsible `claude`.
- Report-time remote heads: 16 = main + rescue + 12 merged heads + 2 older refs.
- Rescue divergence: old `8a3e5e5c0` 5/1; corrected `R` 5/2.
- PR #10 merge to close author time 56s; close to PR #11 merge 29m06.
- PR #14/#15/#16 merges: `17:42:30Z`, `17:56:43Z`, `18:11:21Z`.
- PR #17 body 4,010 Unicode chars; one top-level issue comment plus 9 inline comments and 8 review records. Final diff 34 files `+851/-454`, contradicting body's “30 files, +613/-442.”
- Scheduled failures: report's 12/12 true; maximal streak 15 (Jul 31-Aug 14).
- Governance: all 19 ledger-changing commits after PR #6 through `5dd17ff9e` lacked associated PR.
- Rescue `bw.rs`: sequential churn 489+385=874; combined merge-base delta 756 touched.

## Current-state drift at `2026-08-15T01:54:10+04:00`

This does not alter immutable `A` verdicts, but changes every “right now” statement:

- `main == origin/main == 1883e0752`, one post-report ledger reconciliation after `A`.
- Rescue remains `R`, now `6 behind / 2 ahead`.
- Five local worktrees: main, leak, oracle, ownership, rescue.
- Remote heads 17; PR #18 (`fix/subscribe-reconnect-leak`) open.
- `.devkit/sessions` empty; no automation Electron entry process.
- `.rows` absent; `.devkit` about 8.2G.
- Protection settings remained as reported when queried.

Subsequent final live check at `2026-08-15T02:08:20+04:00`: PR #18 merged as remote main `cc3748af7`; the local main was intentionally left untouched at `1883e0752` and is two commits behind. Rescue is now `8 behind / 2 ahead` of remote main. Remote-head count remains 17. This post-report implementation makes 1.4 stale as a current defect, but it does not change the finding's truth/wording at immutable `A`.

Future audits should record exact `stateObservedAt`, separate immutable Git evidence from mutable process/filesystem/GitHub settings, and mark every sentence superseded by post-audit corrections.

## Core reproduction commands

```sh
# Immutable source and branch deltas
git show 6ce2f0b61:path/to/file | nl -ba
git diff --numstat 8a3e5e5c0..70f0c70ae
git diff --numstat 76a4cc976..70f0c70ae -- native/scan-cleanup/src/bw.rs
git rev-list --left-right --count 6ce2f0b61...70f0c70ae
git merge-tree 76a4cc976 6ce2f0b61 70f0c70ae

# Corpus/baseline/counts
git show 6ce2f0b61:native/scan-cleanup/tests/fixtures/split/fixtures.json | jq 'length'
git show 6ce2f0b61:native/scan-cleanup/harness-baseline.json | jq '.corpus,.catastrophes'
git ls-tree -r --name-only 6ce2f0b61 -- scan-cleanup-core scan-cleanup-adapters \
  | grep -E '\.ts$' | xargs wc -l
node scripts/architecture/generate-scan-cleanup-threshold-baseline.mjs --check

# GitHub state/history
gh run view 31840148788 --json headSha,status,conclusion,createdAt,updatedAt
gh api repos/evb0110/evb-viewer/branches/main/protection
gh api repos/evb0110/evb-viewer/rulesets
gh pr view 17 --json state,mergedAt,mergeCommit,body,comments,reviews,files
gh run list --event schedule --limit 20 --json status,conclusion,createdAt,headSha

# Volatile local state
git worktree list --porcelain
git for-each-ref --format='%(refname:short)' refs/remotes/origin
pgrep -fl automation-electron-app-entry
du -sh .devkit .devkit/*
```

## Coverage ledger

Every report identifier was covered: C1-C5; five baseline bullets; 1.1-1.18; 2.1-2.13; 3.1-3.5; 4.1-4.9; S0-S8; and the universal closure reminder. Recommendations were evaluated separately from factual premises inside each row; no action item was silently treated as fact.

Use the original report as a high-value evidence inventory, not as an executable sequence without the corrections above.
