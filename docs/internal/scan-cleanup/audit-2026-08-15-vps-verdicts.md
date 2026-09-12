<!-- Provenance: copied verbatim from .devkit/analysis/branch-audit-2026-08-15/vps-verification.md (untracked working artifact), produced 2026-08-15. -->
<!-- Independent VPS re-verification of the 2026-08-15 corrective audit. Its companions are tracked beside it: REPORT.txt as audit-2026-08-15-corrective.md, CORRECTIONS.md as audit-2026-08-15-corrections.md, VERIFICATION.md as audit-2026-08-15-verification.md. Body unmodified. -->

# Independent adversarial verification of `REPORT.txt`

Audit date: 2026-08-15 UTC (execution began 2026-08-14 UTC)  
Repository: `evb0110/evb-viewer`  
Audited main object: `6ce2f0b619cd4cc35931f2e220585a7a9f2af1a1`  
Audited rescue object: `70f0c70ae8c1e1f2b7f0d4fce7fc19222de9536e`  
Mode: read-only; detached dispatcher worktree; no repository files, branches, PRs, settings, or processes changed.

## Executive conclusion

The report is unusually evidence-rich, but it is not fully correct. Most repository-state premises are reproducible at the exact objects. Its largest weaknesses are (1) presenting plausible design prescriptions as if the evidence proves they are uniquely necessary, (2) several causal headlines that are stronger than the demonstrated code path, (3) machine-local macOS state that cannot be independently reconstructed from Git or GitHub, and (4) temporal claims superseded by the post-audit commit and the now-successful exact-SHA CI run.

The most consequential correction is that the qualified-picture union is demonstrably monotone-outward and later than the trim loop, but the report does **not** establish that this is “the explanation for twelve failed geometry landings.” That historical, multi-incident causal attribution needs specimen-level or commit-by-commit evidence. Likewise, the recommended internal ordering (partial trim before ownership) is reasonable but not logically forced: the report itself admits that doing ownership first can merely make the partial-trim change appear inert, not incorrect.

Verdict totals and the final coverage count appear in the coverage ledger after every atomic item is entered below.

## Verdict rules

- **VERIFIED** — the precise factual proposition follows from reproducible repository/GitHub evidence.
- **PARTIALLY VERIFIED** — some atomic premises hold, but a qualifier, causal link, count, severity, or proposed necessity is not proved.
- **FALSE** — contradicted by the inspected object or authoritative API evidence.
- **STALE-NOW** — historically supported at the named snapshot/time, but no longer true at the fetched current ref/API state.
- **UNVERIFIABLE** — not reconstructible from the repository, Git object database, or authoritative read-only GitHub data available here.

Recommendations are audited separately from their factual premises. `VERIFIED` on a recommendation means the proposed action is directly supported and internally compatible; it does not mean it is the only possible design. A recommendation is `PARTIALLY VERIFIED` where the goal is supported but the exact implementation/order is discretionary or lacks a red-on-regression proof.

## Reproduction and evidence map

All file locations below are from `6ce2f0b61` unless explicitly labeled `70f0c70ae` or current. The assigned worktree itself was detached at exactly `6ce2f0b61`, so `nl -ba file` is snapshot evidence without changing HEAD. Rescue lines were read with `git show 70f0c70ae:path | nl -ba`.

| Ref | Exact read-only command | Result used |
|---|---|---|
| E1 | `git rev-parse HEAD; git status --short --branch` | detached clean worktree at `6ce2f0b61` |
| E2 | `git cat-file -t 6ce2f0b6...; git cat-file -t 70f0c70a...` | both exact objects exist and are commits |
| E3 | first `git fetch --no-tags origin '+refs/heads/*:refs/remotes/origin/*'` | initial post-audit heads without switching/resetting any checkout: `origin/main=6ce2f0b61`, rescue=`70f0c70ae`; superseded during audit by E19 |
| E4 | `git rev-list --left-right --count origin/main...origin/fix/rescue-caps-fold-mask; git merge-base ...` | `5 2`; merge-base `76a4cc976fbdd17cd82dc0955e420e0fa71f1490` |
| E5 | `git rev-list --count 5dd17ff9e..6ce2f0b61; git log --format=... 5dd17ff9e..6ce2f0b61` | four commits: `32b50f2c7`, `5bb06b395`, `77095bead`, `6ce2f0b61` |
| E6 | `gh pr view 17 --json state,mergedAt,mergeCommit,headRefName,headRefOid,body,comments,url` | merged `2026-08-14T20:55:41Z`; merge commit `6ce2f0b61` |
| E7 | `gh api repos/evb0110/evb-viewer/actions/runs/31840148788` and `/jobs` | run head SHA exact; completed success at `2026-08-14T21:24:01Z`; `gates_ok` success |
| E8 | `gh api .../branches/main/protection`; `gh api .../rulesets` | only required context is Commit Attribution Policy; force pushes allowed; conversations/admin enforcement off; rulesets `[]` |
| E9 | `jq 'length' native/scan-cleanup/tests/fixtures/split/fixtures.json`; ID filter; `nl -ba tests/split_real_fixtures.rs` | 34 fixtures, 5 Luther; assertions at lines 35–48 |
| E10 | `git ls-files scan-cleanup-core/... scan-cleanup-adapters/... | wc -l`; `xargs wc -l` | 30 tracked production `.ts` files, 10,384 physical lines (includes blank/comment lines) |
| E11 | `git ls-files | grep -i weight` | no tracked pathname containing `weight` (this is a pathname fact, not proof that no weight logic exists) |
| E12 | `git for-each-ref refs/remotes/origin ...` | 16 remote heads excluding symbolic HEAD: main, rescue, 12 merged-PR heads, 2 older parked heads |
| E13 | `git show --stat 70f0c70ae`; `git diff --numstat 8a3e5e5c0..70f0c70ae` | second rescue commit: 5 files, 491 insertions, 120 deletions |
| E14 | `gh pr list --state merged ...`; commit/pulls API for four governance SHAs | PR #6–#17 merge times/SHAs; no associated PR for the four queried governance commits |
| E15 | `gh run list --event schedule --limit 12 ...` | all 12 returned scheduled runs concluded failure, 2026-08-03 through 2026-08-14 |
| E16 | `git log -1 6ce2f0b61 -- <path>` | `content.rs` last `b3e8e627f`; baseline last `38f908f8a`; ledger last `5dd17ff9e` |
| E17 | `git check-ignore -v CLAUDE.md .devkit/anything` | `.gitignore:24` ignores `CLAUDE.md`; `.gitignore:29` ignores `.devkit/` |
| E18 | `node scripts/architecture/generate-scan-cleanup-threshold-baseline.mjs --check`; inspect JSON | main baseline count 169 and check passes; rescue JSON count 172 |
| E19 | repeat E3/E4 near report finalization; `git show --stat origin/main`; `git ls-remote --heads origin` | live main advanced to `1883e0752`; rescue now 6 behind/2 ahead; 17 remote heads; new reconnect-fix head `092ee970f` |
| E20 | `CARGO_TARGET_DIR=/home/ubuntu/rescue-research/branch-audit-verification-2026-08-15/disposable-cargo-target cargo run --release --manifest-path native/Cargo.toml --locked -p evb-scan-cleanup --bin scan-cleanup-harness -- --out /home/ubuntu/rescue-research/branch-audit-verification-2026-08-15/disposable-harness-6ce2f0b61 --baseline native/scan-cleanup/harness-baseline.json` | exact `6ce2f0b61` run exited 0: 51 fixtures (37 real/14 synthetic), split 51/51, all 11 catastrophe counters zero, `contentLostOutsideCrop=0`, final `catastrophes: 0` |
| E21 | final repeat fetch/API: `git rev-parse origin/main`; `git rev-list --left-right --count origin/main...origin/fix/rescue-caps-fold-mask`; `gh pr view 18 --json ...` | final live main `cc3748af7`; rescue 8 behind/2 ahead; PR #18 merged reconnect fix at 2026-08-14T22:03:00Z; 17 heads |

One attempted command used the report's shortened script location, `node scripts/generate-scan-cleanup-threshold-baseline.mjs --check`, and failed because the actual tracked path is `scripts/architecture/generate-scan-cleanup-threshold-baseline.mjs`. No output files were created. The corrected command is E18.

E20 compiled into and emitted reports only under the authorized report directory. After capturing the result, both disposable directories were removed; the additional peak footprint was approximately 92 MB, no process remained, and no tracked file changed.

Hygiene disclosure: one delegated reviewer inadvertently used `git merge-tree --write-tree 6ce2f0b61 70f0c70ae` while checking 3.3. It exited successfully and wrote one tiny unreachable tree object (`e247407c…`) to the shared Git object database. It changed no ref, branch, HEAD, index, or worktree and created no reachable commit. I did not run cleanup/gc because deletion was outside authorization. The same conclusion was independently reproduced with the nonwriting legacy form `git merge-tree <base> <main> <rescue>` and no conflict markers. This is the sole known deviation from the “only report writes” boundary.

### Live ref movement during verification

The first fetch reproduced the report's post-audit state exactly: main `6ce2f0b61`, rescue `70f0c70ae`, divergence 5/2, and 16 heads. During this audit, `origin/main` first advanced to direct ledger commit `1883e0752`, then PR #18 merged the reconnect fix and test hardening as `7a9b7efaa`/`cc3748af7`; the reconnect head remains. Final live state is main `cc3748af7`, rescue 8 behind/2 ahead, and 17 heads (E19/E21). This does not alter any exact-snapshot code finding.

`1883e0752` materially resolves or records many report findings: it adds R17/R18, records exact-SHA success, reopens S2/S3, annotates the batch, corrects the reconnect claim, corrects X2's pause-threshold drift, chooses a governance-doc PR exemption and X2/R15 precedence, assigns nightly ownership, documents visible-red-only enforcement, and reconciles the `default` session rule. Accordingly, 2.1–2.6, 2.7's *record correction*, 2.9, the X2 half of 2.12, and parts of 4.4–4.6/4.8 are now **STALE-NOW as missing-record claims**, although their historical verdicts at `6ce2f0b61` remain as stated below. Q1 was clarified rather than repaired: its original planned grammar already disclosed the current pin.

The fixes are not all complete. The new §8 pointer names `COMPLETENESS-CRITIC.md:11–121`, but neither that file nor SYNTHESIS/design-charter exists in the `1883e0752` tree, so 2.13's reproducibility problem survives. D3 decides to delete O6 but the approach still calls it flagship until S6; 4.5's “no disposition” is stale while the document conflict persists. R1–R15 now have stay-fixed fields/cadence, but the definition still cites ignored `.devkit/.../SYNTHESIS.md:5`, so 4.6 is recorded rather than reproducibly computed. The new ledger also carries unsupported claims, notably O6's “~3380” denominator and the incomplete S3 coverage-root remedy.

The reconnect defect is now fixed on current main by PR #18. Its head remains based on `6ce2f0b61`, while the merge landed as `7a9b7efaa` plus test follow-up `cc3748af7`. This makes 1.4 **STALE-NOW as a current-main defect**, while its exact-snapshot analysis remains valid and rescue `70f0c70ae` still lacks the fix.

The exact harness run E20 also undermines current ledger `1883e0752` insofar as it reopens S3 merely because the committed baseline is stale. Baseline regeneration/denominator/CI wiring remain open S4/S3-sequence work, but the audited snapshot's current behavior independently reproduces PR #11's 51/51 and zero-catastrophe result.

### Reconciliation of the six supplied counterexamples

1. **Holds.** E20 refutes REPORT 2.3's behavioral headline. S3's 51/51/zero behavior holds at the exact audited snapshot; only its baseline/wiring evidence debt remains.
2. **Holds.** At `70f0c70ae`, `bw.rs:436` is a non-test production path and the harness calls through it. REPORT 3.5's test-only lead is false.
3. **Holds.** Manifest version 3 and runtime compatibility version 6 are distinct. PR #17 did not bump 6, so a pre-PR-17 binary can pass version smoke while lacking optional fold-clip behavior.
4. **Holds.** Q1 is planned/imperative text that already acknowledges current pins; REPORT 2.12's Q1 accusation is false/selective. Its X2 pause-threshold finding remains valid.
5. **Holds.** Navigation clears subscribers and normal reconciliation returns after the first truthy result. The service remains non-idempotent for duplicate/exceptional retry calls within a lifecycle, but ordinary navigation does not accumulate listeners forever.
6. **Holds.** The proposed unprotected-only partial trim retains the same extreme and becomes zero-thickness. Its landing order before 1.1 is not logically required.

## Snapshot and post-audit corrections

### Baseline correction

- **VERIFIED** — main at the audited object is exactly `6ce2f0b61`, four commits after `5dd17ff9e`; E1/E5 reproduce the exact order and SHAs.
- **VERIFIED** — PR #17 is merged at the stated second with merge commit `6ce2f0b61` (E6).
- **STALE-NOW** — run `31840148788` was described as `in_progress` and therefore unattested. The API now records success, with `gates_ok` at 21:24:00Z and run completion at 21:24:01Z (E7). The API proves the later state; it does not preserve a status-transition event proving the exact instant the report observed `in_progress`, so that historical observation alone is not independently replayable.
- **UNVERIFIABLE** — the existence/nonexistence of the two `/Users/evb/WebstormProjects/...` worktrees was machine-local state on another host and is not encoded in the repository or GitHub.
- **PARTIALLY VERIFIED** — “R16 steps 0 and 1 landed; 2–6 absent.” The cited step-0 and raster step-1 changes are present. Step 2 is not wholly absent: its preview-harness composition subpart landed in `32b50f2c7`, as the report itself later acknowledges in 2.1. The remaining wiring/enforcement work is absent.
- **UNVERIFIABLE** — the claim that `rg` corrupted output in the originating environment. It is a sensible caution but leaves no durable evidence.

### C1–C5

- **C1 — VERIFIED** — `70f0c70ae` has the stated subject, parent `8a3e5e5c0`, remains the rescue tip, and its commit delta is exactly 491 insertions/120 deletions across the five named Rust files (E3/E13). “491 dirty lines” should read “491 inserted lines”; it is not the total changed-line count.
- **UNVERIFIABLE** — cleanliness of the original macOS rescue worktree and original local-tip equality at that past instant.
- **C2 — VERIFIED** — at `70f0c70ae`, the picture union is `content.rs:583–599`, its outward sides are 593–596, and the source-exclusion clamp is later at 601–616, with assignments at 609–612. Thus “appended stage” is a correct structural description. The correction's shorthand `593–595` omits the bottom-side expansion at 596 but does not change the conclusion.
- **C3 — STALE-NOW** — the first fetch reproduced 5 behind / 2 ahead exactly, correcting pre-correction 3.3. After ledger and PR #18 commits advanced main, the final live count is 8 behind / 2 ahead (E21).
- **C4 — STALE-NOW** — exact-SHA attestation was pending at the stated report time, but the run is now successful (E7). “Steps 0 and 1 remain unattested” must no longer be used as a current blocker.
- **PARTIALLY VERIFIED** — C5's union, baseline values, protection settings, and empty tracked `weight` pathname search reproduce (E8–E11).
- **STALE-NOW** — C5's 16-head count was correct on the first fetch; it is now 17 because `fix/subscribe-reconnect-leak` appeared (E19). The 12 stale merged heads remain a subset.
- **UNVERIFIABLE** — C5's live Electron session and untracked zero-byte `.rows` file were machine-local observations. They should not be described as reverified *at a commit object*, which cannot encode processes or untracked files.

## 1. Still-broken claims

### 1.1 — qualified-picture union

- **VERIFIED** — `content.rs:347–356` receives trim bounds/diagnostics; `:392–408` then unions a qualified picture mask with `min` on left/top and `max` on right/bottom. Apart from setting the entire option to `None` for an edge sliver at `:410–414`, it is the last side-coordinate assignment.
- **VERIFIED** — `crop_qualified_picture_bounds_with_authority` at `:958–973` has mask/authority/artifact/calibration inputs and cannot see `blocks`, `active`, or `accepted_trims`; the trim loop is `:1871–1981`.
- **VERIFIED** — this arrangement can re-expand an accepted trimmed side whenever the qualified picture bound crosses that side. `content.rs` was last changed at `b3e8e627f`, not by PR #17 (E16).
- **UNVERIFIABLE** — “this is RC2, the explanation for twelve failed geometry landings.” The ledger repeats/adopts that hypothesis but supplies no twelve-landing denominator, per-commit path trace, or specimen result showing this mechanism caused each failure. The headline severity is therefore stronger than its evidence.
- **PARTIALLY VERIFIED** — one-owner design plus an export-level pinning test is well supported, but the evidence does not select uniquely between the report's two proposed implementations.

### 1.2 — catastrophe oracle

- **VERIFIED** — baseline values are exactly `contentLostOutsideCrop=2`, split errors `1+1`, split/Luther/total `33/4/50`, and one sample has `lostInkFraction=1.0` (`harness-baseline.json:9,24–25,34–36,59,145–149`). Four nonzero *catastrophe counters* are blessed; `lostInkFraction` is a metric/sample, not a fifth counter.
- **VERIFIED** — baseline last changed in `38f908f8a`; `140802859` added a Luther fixture without updating it. Live tracked fixture denominator is 34, including five Luther cases (E9/E16), so the baseline is one page stale.
- **VERIFIED** — `evaluate.rs:401–441` compares catastrophe counts without corpus denominators, permitting a smaller corpus with equal/lower raw counts to pass.
- **FALSE** — “its only unit test compares the baseline to itself.” `evaluate.rs:1046–1064` contains that vacuous equality at `:1048–1051`, but also a real mutated-regression assertion at `:1053–1063`. The report later concedes this, contradicting its own headline.
- **PARTIALLY VERIFIED** — “nothing calls it.” The CLI calls comparison when `--baseline` is passed (`main.rs:45–69,87–91`); the accurate claim is that no package script or workflow invokes it.
- **PARTIALLY VERIFIED** — denominator assertion, fresh-report testing, and CI wiring directly address proven gaps. Requiring all counters to be zero or moved to named exceptions is a policy choice, not entailed by the stale denominator alone.

### 1.3 — branch protection

- **VERIFIED** — current authoritative settings are exactly those reported (E8); `.husky/pre-push` contains only the attribution command; quality jobs and `gates_ok` ran successfully on `6ce2f0b61` but are not required.
- **UNVERIFIABLE** — GitHub's current protection endpoint is not a historical snapshot. Without an audit-log event, it cannot independently prove that settings were identical at the precise commit time, though the report's observation and unchanged current state are mutually consistent.
- **PARTIALLY VERIFIED** — “PR-based landing currently guarantees nothing” is rhetorical overstatement: it guarantees the one required attribution context when protection applies. It guarantees no required product-quality result, admins are not enforced, and force pushes remain allowed.
- **VERIFIED** — the proposed required aggregate/force-push/conversation changes match the demonstrated gap; the requested DONE state is not true today.

### 1.4 — progress listener leak

- **VERIFIED** — `createScanCleanupService.ts:622–632` obtains but neither retains nor invokes the unsubscribe; `scanCleanupMainBindings.ts:36–37` routes both subscribe and reconnect through it.
- **VERIFIED** — the actual registry path is `electron/operation-lifecycle/createMainJobRegistry.ts` (the report omitted `operation-lifecycle`). It stores subscribers in a Set (`:177,:363`), adds a new closure and returns its deleter (`:442–448`), and clears only at record removal/owner end (`:249–251,:303–305`). Function identity prevents deduplication.
- **PARTIALLY VERIFIED** — the coordinator allows up to three reconciliation attempts (`scanCleanupRunCoordinator.ts:17,227–243`), but it returns after the first successful state. It does not necessarily leak three listeners per reconciliation; it leaks one per successful subscribe/reconnect invocation.
- **FALSE** — the unqualified claim that every ordinary navigation reconnect “permanently adds” a listener. Navigation invokes `ownerEnd`, which clears all record subscribers before detach (`createMainJobRegistry.ts:303–309`); the restored session then adds one. The service is non-idempotent for duplicate/retried calls without that cleanup, but normal navigation does not accumulate forever.
- **PARTIALLY VERIFIED** — `32b50f2c7` removed both start-side registrations, eliminating the ordinary start-plus-subscribe duplicate. It did not make subscribe/reconnect idempotent: duplicate calls or exceptional retries within one owner lifecycle can still accumulate closures.
- **PARTIALLY VERIFIED** — “permanently for life of the job” should say until owner-end or retained-record disposal; terminal completion alone need not be the exact cleanup instant.
- **STALE-NOW** — PR #18 fixes current main, but rescue `70f0c70ae` is based before PR #17 and still has both start-side registrations plus the discarded reconnect handle. The audited defect survives on rescue, not current main.

### 1.5 — TypeScript coverage blind spot

- **VERIFIED** — `vitest.config.ts:14–20` omits both directories; `checkZeroExecutionCoverage.ts:99–105` scans only app/electron/packages. E10 reproduces 30 tracked production `.ts` files and 10,384 physical lines.
- **FALSE** — adding those directories to `roots` is not sufficient to make the tripwire list their zero-execution files. `isZeroExecutionTripwireTarget` (`checkZeroExecutionCoverage.ts:64–81`) accepts selected IPC/contracts/worker/load-bearing paths, and the load-bearing list contains no core/adapters path. Merely adding roots leaves the target count unchanged unless the predicate/list is broadened too.
- **FALSE** — “the tripwire reads `coverage.include`; widening one alone yields a wall of false missingFiles.” It reads the generated coverage summary and compares it with its independently selected targets (`:116–145`). Coverage include alone does not create the claimed wall; roots alone do nothing for paths rejected by the predicate.
- **PARTIALLY VERIFIED** — coordinated coverage expansion is needed, but the prescribed two-edit SAME-commit fix is incomplete. Also, 10,384 physical source lines are not equal to V8's executable `lines.total`, so the DONE denominator is misstated.

### 1.6 — generated-output lifecycle

- **VERIFIED** — generated outputs live below Electron's temp path, in UUID directories, with a seven-day directory-mtime threshold (`generatedOutputs.ts:27,31–33,90–100,121–141`; `appTempDir.ts:17–24`). File reads do not update the directory mtime.
- **VERIFIED** — generated PDFs are deliberately excluded from Recent Files (`openInputPaths.service.ts:203–237`); success shows summary plus Save As, failure shows the raw path (`scanCleanupRunCoordinator.ts:303–327`).
- **PARTIALLY VERIFIED** — “continued use does not refresh” needs the liveness caveat. A currently registered working-copy original is skipped twice during pruning (`generatedOutputs.ts:131,137`); risk returns after closure/unregistration because use never refreshes age.
- **PARTIALLY VERIFIED** — “feature's only deliverable” ignores a user-created Save As copy. It accurately describes the automatically generated artifact.
- **PARTIALLY VERIFIED** — touching on open is directly responsive. Registering in Recent Files without also ensuring persistence/prune ordering could create a Recent entry to a subsequently removed file; durable location or an access/retention contract is still needed.

### 1.7 — packaged sidecar smoke

- **VERIFIED** — macOS executes packaged `evb-scan-cleanup --version` and `--protocol-version` (`verify-packaged-native-tools.sh:515–528`). Linux executes only tesseract/unpaper (`:558–563`); Windows only tesseract (`:585–589`).
- **VERIFIED** — release matrix has five target legs and calls the verifier on all (`build.yml:25–48,288–290`), so four of five packaged sidecar artifacts lack execution evidence. They still receive static/file/dependency checks; “zero execution evidence” must not be paraphrased as zero verification.
- **VERIFIED** — policy entries exist (`native-tool-smoke-policy.mjs:43–50`); host helper uses exit-zero plus a caller regex rather than that policy, while the mac helper routes through the assertion script.
- **VERIFIED** — PR #17 added optional public-manifest-v3 metadata fields at `nativeProtocolV3.ts:170–171`; that public JSON version remains 3.
- **VERIFIED** — packaged `--protocol-version` prints Rust `PROTOCOL_VERSION`, sourced from `nativeToolProtocols.ts` runtime compatibility revision 6. Version 6 already existed at parent `5dd17ff9e` and did not change in PR #17; it is distinct from manifest version 3.
- **VERIFIED** — protocol behavior is identical at `6ce2f0b61`, docs-only `1883e0752`, and final current main `cc3748af7`: public manifest 3, runtime compatibility 6.
- **FALSE** — the DONE claim that a deliberately stale pre-PR-17 sidecar would necessarily fail version/protocol smoke. Such a sidecar can still print the same binary version and runtime protocol 6 while omitting the new optional fold-clip outputs. Execution smoke closes “never launched” exposure but does not by itself attest the optional field behavior.
- **PARTIALLY VERIFIED** — the proposed Linux/Windows calls are still appropriate. Naming win-arm64 as a non-executable gap is correct for the x64-host cross-build, but protocol/behavior compatibility needs a request/result assertion beyond `--protocol-version`.

### 1.8 — Rust target coverage

- **VERIFIED** — the only PR/push Rust test/lint/deny/build job is `pr_native_build_safety` on `ubuntu-latest` (`ci.yml:235–279`). Manual and nightly Rust paths are also Ubuntu and do not add a PR/push target (`:458–497,:564–627`).
- **PARTIALLY VERIFIED** — “exactly one target triple” is inferred from GitHub's current `ubuntu-latest` x64 runner; the workflow does not explicitly pin `--target` or even `ubuntu-24.04`. That host corresponds to one of five shipped platform-arches (linux-x64), while four others lack Rust test execution.
- **UNVERIFIABLE** — “neither the development platform” depends on the developers' machine state, not tracked evidence.
- **PARTIALLY VERIFIED** — adding arm64 would cover one additional shipped architecture, not macOS/Windows. Documenting the blind spot is an honest alternative, as the report says.

### 1.9 — whole-side trim veto

- **VERIFIED** — one picture-mask overlap pixel or the text-evidence boolean protects a block (`content.rs:699–704`). Text evidence is backed by a validated text-mask construction with fill/peak gates (`:1511–1531,:1607–1619`), so this is not literally one arbitrary ink pixel.
- **VERIFIED** — `build_trim_geometry` selects all active blocks touching the side extreme and aborts the side if any is protected (`:2048–2068`). The loop changes the active set only after another proposal is accepted (`:1898–1954`), so the veto can persist.
- **FALSE** — “remove only the unprotected touching blocks” is not a complete rectangular-bound fix. If a protected survivor still touches the same extreme, recomputing `remaining_bounds` retains the same side and yields zero trim. It requires different geometry/block semantics or a protection-threshold change; the proposed algorithm alone cannot deliver its stated result.
- **FALSE** — “land this BEFORE 1.1” is not logically established. The prescribed partial-removal algorithm already returns a zero-thickness/no-op while a protected extreme survives, independent of the later union. Fixing ownership first does not make a correct future trim implementation invalid. No R10/R12 specimen trace proves this mechanism is their cause.

### 1.10 — Sauvola reachability

- **VERIFIED** — `bw.rs:874` caps measurement to 256; `:893–895` scales the sampled median run; `:1288–1291` requires estimated width `<=8`. A positive minimum sampled run of 1 becomes 13.703 at max dimension 3508 and 19.375 at 4960, so full-size A4/spread inputs cannot choose this arm on positive measured runs.
- **FALSE** — “reachable only where `sample_scale == 1.0`.” The condition is `median_run * sample_scale <= 8`; many scales above one pass, and no qualifying run returns zero (`estimated_stroke_width`, `:1868–1905`).
- **PARTIALLY VERIFIED** — the “three of four production entry points” accounting is wrong. `bw.rs:219` is reachable in-repo only from tests; full-input paths at `:339` and `:931–933` differ from normal raster production, which supplies capped routing samples from `render.rs:5810,6020` through `bw.rs:255–257`.
- **FALSE** — the hand-fed 3.0 test value is not something “no measured page produces”: capped production routing has scale one and can measure 3.0. The narrower full-size-A4 statement is true.
- **PARTIALLY VERIFIED** — resolving units and recording route distributions are sound, but the report has not shown the arm dead across production's actual input-size distribution.

### 1.11 — fold-band representation

- **VERIFIED** — `split.rs:215–216` uses two `Option<f64>` values; `leaf_polygons` at `:2616–2626` makes two leaves meet at the cutter when absent; diagnostics has no absence reason.
- **PARTIALLY VERIFIED** — initial nonmeasurement and moved-cutter invalidation reach this fallback (`:224–251,:272–295`). Abstention does not: it clears cutter/band and directly emits one page at `:327–345`.
- **UNVERIFIABLE** — “least conservative” is not supported by calibration or comparative loss data.
- **PARTIALLY VERIFIED** — a reason-carrying enum improves observability, but using a nominal band as the conservative degraded behavior is a product/design choice not established by the evidence.

### 1.12 — lossless placement duplication

- **VERIFIED** — lossless preview independently derives pixel placement (`createScanCleanupPreviewService.ts:2203,2367–2380,2398–2399`); export independently calls point-space `placeUniformBox` (`runLosslessScanCleanup.ts:419–446`; definition `documentCanvas.ts:733–754`). `32b50f2c7` touched neither file.
- **PARTIALLY VERIFIED** — two implementations do not alone prove divergent numerical output, but they do disprove the literal “same program” claim and leave lossless identity unattested.
- **PARTIALLY VERIFIED** — unification and a lossless identity case are well-motivated; which side should own placement remains a design choice.

### 1.13 — OCR option inheritance

- **VERIFIED** — OCR sends only `{dpi}` plus `--ocr-mode` (`tryPreprocessOcrImage.ts:85–97`); CLI parsing fills omitted values from `CleanupOptions::default` (`batch_cli.rs:419–426`; `options.rs:487–505`). Defaults include Auto binarization, illumination normalization, despeckle, and BW.
- **VERIFIED** — `ocr_mode` branches address layout/page/crop concerns, not a separate binarization/rescue policy. Existing TypeScript tests mock command execution; native OCR tests pin geometry rather than pixel identity.
- **PARTIALLY VERIFIED** — rescue changes can reach OCR's binarization path, but no OCR-side before/after specimen establishes harmful pixel change. The side-effect risk is real; the severity remains prospective.
- **PARTIALLY VERIFIED** — explicit OCR options are a valid isolation strategy, but “full options object OCR wants” first requires a stated OCR pixel policy/oracle.

### 1.14 — dead/self-blessing controls

- **VERIFIED** — the non-preview `match_page_sizes` branches are production-unreachable through the sole call at `batch_cli.rs:825–829`: final matched outputs are marked in-memory and filtered before branches at `:4030,:4100,:4107`.
- **VERIFIED** — quarantine tests pin `blocking:false`, 30 green runs, and continue-on-error (`quarantineGraduationPolicy.test.ts:108–116,147–167`).
- **VERIFIED** — `package.json:68` runs the named-float check; main count is 169 and rescue count 172 (E18); `90bf08248` changed 168 to 169 alongside code.
- **UNVERIFIABLE** — “169 of ~3380 tuning numbers.” No reproducible population definition for 3380 is present; simple numeric-literal counts vary far above it depending syntax. Narrow coverage is established, that denominator is not.
- **PARTIALLY VERIFIED** — calling the O6 check “actively harmful” is not backed by an incident caused by the gate. Delete/keep is a policy decision, and the report correctly warns not to delete the genuine second half of the evaluate test.

### 1.15 — packaged application E2E

- **VERIFIED** — `verify-local-package.mjs:144–160` is mac-only, requires ignored `.devkit/scan-cleanup-release-fixture.json`, and honestly prints SKIPPED. The package command exists, while release workflows call only `release:verify:checks`.
- **UNVERIFIABLE** — “strongest end-to-end gate” is a subjective ranking, and the three example regressions were not failure-injected here.
- **PARTIALLY VERIFIED** — a committed synthetic fixture plus CI wiring would close the caller gap; honest reclassification instead documents rather than closes it.

### 1.16 — local process/isolation state

- **UNVERIFIABLE** — PID, process count/RSS, start time, crash-report count, responsible process, and stage-boundary assertions concern the original macOS host and have no durable artifact here.
- **VERIFIED** — tracked rules contradict tracked scripts: ledger `:104–108` says per-track session names are never `default`, while `package.json:21` hardcodes `--session=default` for `dev:headless`.
- **PARTIALLY VERIFIED** — reconciling the rule/script is supported. Stopping and checking the original process was an operational action, not a repository conclusion, and cannot be declared done from this VPS.

### 1.17 — `.devkit` size

- **UNVERIFIABLE** — `.devkit` is absent here and ignored (`.gitignore:29`), so the 8.5G total, category sizes, largest leaves, 288K preservation set, and fixture dependency state on the source Mac cannot be independently reproduced.
- **FALSE** — “unrecoverable working material” overstates what ignored means. It is unrecoverable *from Git*; extant files, backups, or regeneration may still make it recoverable.
- **PARTIALLY VERIFIED** — pruning after resolving fixture dependencies is prudent but depends on source-host inspection and ownership decisions outside this audit.

### 1.18 — branch/file debt

- **VERIFIED** — GitHub reports PRs #6–#17 all merged on 2026-08-14 with exactly the 12 listed heads, and all heads remain. Because rebase merges do not make those head tips ancestors, GitHub PR metadata is the appropriate authority.
- **STALE-NOW** — `origin/main` and `origin/fix/preview-truth` had zero file differences and the total was 16 on the first fetch. Current main now differs by ledger/approach plus PR #18 service/registry/tests, and the reconnect head raises the count to 17 (E21). The two older parked-tip dates remain verified.
- **UNVERIFIABLE** — local `p1a-parked` and the untracked zero-byte `.rows` file were source-machine state. The assigned worktree is clean and has no such evidence.
- **PARTIALLY VERIFIED** — branch debt is real, but “what is in flight is unanswerable” is rhetoric. Deletion/parking requires an ownership decision; GitHub history alone cannot establish that no consumer still needs a head.

## 2. False/stale evidence claims

### 2.1

- **VERIFIED** — the ledger's last commit is `5dd17ff9e`; it has no R17 and no rows for PR #13/#14/#16/#17; step 0 and raster step 1 remain written as pending at `:403–411` although they landed through PR #17.
- **VERIFIED** — `32b50f2c7` plus `77095bead` contain the cited sidecar and raster-placement/fold-clip work; disclosure now precedes the match-page-size early out.
- **PARTIALLY VERIFIED** — part of nominal step 2 (preview-harness composition through native placement) also landed in `32b50f2c7`, so the baseline statement that steps 2–6 are “ABSENT” is too absolute. Whole step 2 remains incomplete.
- **STALE-NOW** — citing the push run as pending was right before 21:24Z but exact-SHA success now exists (E7).
- **VERIFIED** — the reconciliation recommendation is supported, with lossless explicitly left open.

### 2.2

- **VERIFIED** — ledger S2 closure at `:156–165` contradicts R11 `:320–334`, R13 `:352–368`, and R16 `:419–426,:457–460`.
- **STALE-NOW** — “the fix exists only at `8a3e5e5c0` plus five dirty files.” The exact dirty delta is now committed/pushed at `70f0c70ae` (C1/E13).
- **PARTIALLY VERIFIED** — calling that candidate “the actual fix” is premature because the report itself says the required oracle does not exist. It is candidate code, not an accepted fix.
- **VERIFIED** — reopening/downgrading the ledger status follows its own later evidence; re-closing requires a durable criterion.

### 2.3

- **FALSE** — the headline that S3's behavioral 51/51/zero result is false. Independent exact-snapshot E20 ran the release harness on 51 fixtures, produced split 51/51, `contentLostOutsideCrop=0`, and all 11 catastrophe counters zero. The stale baseline is an allowable regression ceiling, not a measurement of current output.
- **VERIFIED** — the tracked baseline is stale at 50 fixtures with nonzero counters, has no denominator enforcement, and is unwired; ledger PR #11 status “in merge tail” was also stale after merge.
- **PARTIALLY VERIFIED** — regenerating the baseline, adding denominators, and wiring CI are supported S4/governance work. Those omissions do not reopen the demonstrated S3 behavioral fix; whether all ignored `.devkit` ground-truth adjudications/probes were sound remains independently unavailable.

### 2.4

- **VERIFIED** — `3861c35f1` closed S2/S3 at 09:13:22Z; PR #10 merged 56 seconds earlier and PR #11 29m06s later. This breaches ledger G3's one-hour soak, including closure before the named S3 fix existed on main.
- **PARTIALLY VERIFIED** — this is a clear governance violation, not evidence of a current product blocker. Mechanical enforcement versus deleting G3 is a policy choice.

### 2.5

- **VERIFIED** — preview harness has a package command and a key-existence test but no executing CI caller; “GATES” is false under the approach document's vocabulary.
- **VERIFIED** — stay-fixed appears only at ledger `:400,:446`; no mechanism computes or schedules it.
- **VERIFIED** — relabeling these as manual/hand-maintained is the minimum truthful correction.

### 2.6

- **VERIFIED** — the four named governance SHAs have no associated PR; a complete range check found 19 ledger amendments after PR #6, all without associated PRs. That conflicts with the tracked/CodeRabbit-visible rationale at ledger `:6–8` and approach `:12–14,:453–456`.
- **PARTIALLY VERIFIED** — direct commits are still tracked; the failure is specifically absence of PR/CodeRabbit review. The proposed exemption-or-PR decision is governance policy.

### 2.7

- **PARTIALLY VERIFIED** — the commit message overclaims complete reconnect cleanup. It correctly removed normal start-side duplication, but the discarded handle leaves same-lifecycle duplicate/exceptional retry calls non-idempotent (see 1.4).
- **STALE-NOW** — current main now carries the reconnect fix via PR #18; rescue remains based before PR #17 and still reintroduces the start-side subscriptions, an integration risk omitted from the original item.

### 2.8

- **VERIFIED** — PR #17 body/comments contain no user-attachment or before/after pack reference; only one issue comment, from CodeRabbit. The same repository-visible absence holds for the other named PRs.
- **UNVERIFIABLE** — delivery in chat cannot be checked from GitHub/repository evidence, exactly as the report concedes.
- **PARTIALLY VERIFIED** — under ledger `:43–50`, missing delivery/reference invalidates process closure but is explicitly nonblocking for continued work; it does not prove the code wrong.

### 2.9

- **VERIFIED** — the open batch list remains unannotated. PR #14/#15/#16 merge times match the report, while fold/weight work remains off main on rescue.
- **STALE-NOW** — “stranded” is too strong after C1: the two unlanded items are remotely durable, though still not accepted/merged.
- **UNVERIFIABLE** — adequacy of chat/export evidence is not reconstructible from repository-only material.

### 2.10

- **FALSE** — “Every cited closure number is unreproducible.” E18 reproduces O6 count 169; E9 reproduces fixture counts. The absolute headline is contradicted.
- **VERIFIED** — the specific 1,691-word result and cited S3/S5 `.devkit` artifacts/scripts are ignored/untracked and not reproducible from a clone; no tracked weight pathname exists (E11/E17).
- **FALSE** — the action says copy “SYNTHESIS and section 7/8,” while 2.13 says SYNTHESIS has only sections 1–7 and §8 is elsewhere. The durable sources must be named separately.

### 2.11

- **VERIFIED** — `.coderabbit.yaml:29–60` has six path-instruction blocks and references no document; `CLAUDE.md` is ignored and absent here; the architecture audit file is tracked.
- **UNVERIFIABLE** — because ignored `CLAUDE.md` is not supplied, this audit cannot prove that all binding Design/OCR/UI/Native-CI rules actually live there.
- **PARTIALLY VERIFIED** — a tracked design charter would solve the durable-source problem if that premise is confirmed; it is not the only possible filename/layout.

### 2.12

- **VERIFIED** — approach X2 says auto-pause after two while `.coderabbit.yaml:66` says 10.
- **FALSE** — the report's accusation that Q1 is a stale implementation claim selectively reads a planned mechanism as current state. Q1 is grammatically imperative (“Graduate ...”), explicitly says the architecture test *currently* pins `<30`/`blocking:false` and that policy plus test change together; Part 4 later says “then graduate ...; retire” (`:418–423`). Its present-tense “bar is retired” wording was awkward, but it already disclosed nonimplementation. Current `1883e0752` merely clarifies intended-but-open status.
- **VERIFIED** — the documents/mechanism need one reconciled disposition.

### 2.13

- **PARTIALLY VERIFIED** — ledger `:449` points to untracked “audit §8,” so the pointer is non-reproducible from a clone. The asserted 167-line SYNTHESIS and COMPLETENESS-CRITIC location are absent and independently unverifiable here.
- **UNVERIFIABLE** — “probably how 2.11 got misstated” is causal speculation with no evidence.

## 3. Rescue branch

### 3.1

- **STALE-NOW** — the original no-commit/no-remote durability blocker is no longer true. The exact five-file delta is committed and remotely durable at `70f0c70ae` (C1/E13).
- **UNVERIFIABLE** — original stash state, local-tip equality, clean source worktree, and the `.devkit` cleanup risk are historical source-Mac facts.

### 3.2

- **VERIFIED** — the rescue union remains at `content.rs:583–600`, followed by horizontal clamp `:601–616`; whole-side abort remains at `:2250–2276`.
- **PARTIALLY VERIFIED** — “reproduces RC2” overstates behavior. Unlike the outward union, the later inward clamp can enforce the desired cap, and `source_exclusion` is also consumed before the union. It is undeniably appended/multiple ownership, but no specimen demonstrates failure caused by that order.
- **PARTIALLY VERIFIED** — deletion/re-adjudication after ownership work is a coherent plan, not a proven unique fix.

### 3.3

- **VERIFIED** — merge-base is `76a4cc976`; corrected divergence is 5 behind/2 ahead; main and rescue both changed `render.rs`; the oracle prerequisite is absent; first commit message says only “blockers open.”
- **FALSE** — “a conflict is pending.” Read-only `git merge-tree <base> 6ce2f0b61 70f0c70ae` reports `render.rs` changed in both but emits no conflict markers; Git auto-merges the current tips.
- **PARTIALLY VERIFIED** — “cannot legitimately merge” is a governance judgment. Rebase and explicit blocker documentation are reasonable, but absence of a textual Git conflict weakens the stated rationale.

### 3.4

- **VERIFIED** — `bw.rs` has 489 changed lines in `8a3e5e5c0` plus 385 in `70f0c70ae`, 874 total. The four earlier family commits and R11/R13 chronology match.
- **VERIFIED** — harness collapses each word to a mean and raises `weight-uniformity` only on preview/final deviation above 0.15; it cannot reject equally uneven absolute outputs. No tracked weight pathname exists.
- **PARTIALLY VERIFIED** — “fifth landing” is an informal family classification rather than a durable identifier. Freezing acceptance until an absolute-output oracle exists is well supported.

### 3.5

- **VERIFIED** — at `70f0c70ae`, `rescue_component_scoped_faint_strokes` remains a delegating wrapper to `_excluding_source` (`bw.rs:1354–1376`).
- **FALSE** — the lead that its remaining callers are tests. `bw.rs:436` is outside `cfg(test)` on the chain `clean_black_and_white` → `clean_black_and_white_with_calibration_config` → `binarize_normalized_calibrated` → `binarize_with_mode` → wrapper. Harness `evaluate.rs:572–580` calls `clean_black_and_white_with_calibration_config`, so the wrapper has a production harness caller; the public cleaning API is also production-capable even though app render paths use `_excluding_source` directly.
- **FALSE** — cited lines are materially wrong: test calls occur well before the stated `bw.rs:3928–4308`, and `render_tests.rs:3690` is not the relevant call (actual rescue calls include `:601,:690,:1041`). This is more than ordinary drift.
- **UNVERIFIABLE** — no GitHub checks/runs exist for `70f0c70ae`, proving lack of remote compile attestation, not that no local compile ever occurred.
- **PARTIALLY VERIFIED** — review under the one-consumer rule is appropriate if that rule is confirmed in the absent local charter.

## 4. Forward-plan defects

### 4.1

- **VERIFIED** — a local Husky hook is clone-local, bypassable, absent unless installed, and cannot enforce remote merges. The current hook only checks attribution; `gates_ok` is not required (E8).
- **VERIFIED** — wiring checks into CI is a repository change and creates an executing caller; making them *merge-blocking* additionally requires protection/ruleset configuration.
- **PARTIALLY VERIFIED** — “the enforcement decision IS the blocking CI job” conflates execution with enforcement. A job becomes remote enforcement only when a protected branch requires its stable context; the report later states this caveat correctly.

### 4.2

- **VERIFIED** — no tracked weight oracle exists; the named `.devkit` source is ignored and unavailable; rescue fixtures are tracked at `70f0c70ae`.
- **UNVERIFIABLE** — PIL import and precise ignored-script behavior cannot be checked because the cited script is not supplied.
- **FALSE** — “Every repo gate is pnpm/vitest or cargo” as a literal language/ecosystem claim. CI installs Pillow at several jobs, package scripts include tracked Python diagnostics, and packaged cleanup verification can invoke Python. There is no current *weight* lane, which is the narrower verified claim.
- **PARTIALLY VERIFIED** — Rust or tracked JS are viable runners, but “do not add a Python lane” is preference, not an evidence-derived constraint.
- **PARTIALLY VERIFIED** — making the Sauvola check a strict precondition depends on the overstated 1.10 premise.

### 4.3

- **VERIFIED** — ledger makes fold work conditional on ownership while rescue bundles geometry and binarization; those surfaces are separable.
- **PARTIALLY VERIFIED** — “wrong order” is optimization/design judgment, not a falsified plan. The branch can be split, and ownership may be implemented before or alongside the oracle.
- **FALSE** — the stated mandatory internal ordering relies on 1.9's incomplete partial-trim algorithm. Ownership first might make a later trim change look inert; that does not make ownership incorrect, and picture versus text vetoes have different dependencies.

### 4.4

- **VERIFIED** — `evaluate.rs:919–921` emits content-loss counts; the word-loss script computes `lostInkFraction` and a 0.01 comparison. R16 does not assign a content-loss step; S5 remaining and S6 are also orphaned; E15 proves the 12/12 scheduled-failure streak.
- **PARTIALLY VERIFIED** — “neither has a workflow caller.” The word-loss audit is indirectly invoked by quarantined `scanCleanupUniformity.e2e.test.ts`, and scheduled CI runs that project, but it skips without unprovided fixture env vars and, if enabled, uses `--fail-on none`. There is no effective content-loss gate.
- **UNVERIFIABLE** — the absent SYNTHESIS source cannot independently prove that it named this as the final acceptance class.
- **VERIFIED** — explicit disposition/ownership for omitted items and the nightly red streak is supported; exact grouping into step 2 remains planning discretion.

### 4.5

- **VERIFIED** — ledger schedules O6 deletion while the approach calls it flagship/defect-generation and package scripts enforce it; rescue bumps 169 to 172. This is a direct governing-document contradiction.
- **PARTIALLY VERIFIED** — keep/delete cannot be decided from the supplied evidence. If kept, its claim must be narrowed; if deleted, dependent documentation/tests must change together.

### 4.6

- **VERIFIED** — stay-fixed is prose-only, occurs twice, and has no row field/cadence, so its two-month deletion rule cannot be mechanically evaluated.
- **UNVERIFIABLE** — claimed SYNTHESIS counts (`3`, `~19`, `>=9`, `0`) and the report's “at least five” re-derived families lack the cited durable source and a reproducible classification procedure.
- **PARTIALLY VERIFIED** — adding structured outcomes/cadence is responsive, but retrofitting every R1–R15 may be unnecessary governance expansion unless the metric will actually drive decisions.

### 4.7

- **VERIFIED** — lossless preview/export placement is independently computed (1.12), so raster identity evidence cannot attest lossless screenshot-to-export identity.
- **PARTIALLY VERIFIED** — “closure vocabulary not satisfiable” is overbroad: a lossless export can be measured directly. What is inadmissible is using preview screenshots alone as export evidence.
- **VERIFIED** — adding a lossless identity case is needed before reusing preview evidence for that path.

### 4.8

- **VERIFIED** — PR #17 explicitly carried step 0 plus step 1; file list confirms sidecar and preview surfaces.
- **PARTIALLY VERIFIED** — a strict one-step/one-PR rule is not solely at X2 `:16–19`; the explicit anti-batching decision is ledger `:124`. The violation is real against the latter, but the citation/rule name is imprecise.
- **PARTIALLY VERIFIED** — R15 governs whole user-report batches and does not clearly authorize combining procedural steps. Recording precedence is sensible.

### 4.9

- **VERIFIED** — tracked search finds the supported-document-class phrase only in R16 and an unrelated dense-text comment, so no declaration exists.
- **PARTIALLY VERIFIED** — putting it last and requiring a route distribution are coherent dependencies, not facts. The declaration also needs product-scope authority, not only measured router reachability.

## Corrected sequence S0–S8 and closure reminder

The sequence is not itself an implementation result. The rows below audit whether each embedded status, dependency, action, and DONE condition follows from the evidence.

### Disposition of original steps

- **VERIFIED** — step 0 landed in the named commits and now has successful exact-SHA push attestation (E7).
- **PARTIALLY VERIFIED** — step 1 landed for raster and remains open for lossless identity; the report cannot independently verify the missing chat eyeball pack.
- **PARTIALLY VERIFIED** — step 2 “stays/splits” is reasonable, but calling its job “blocking” requires settings as well as workflow wiring; some preview-harness composition already landed.
- **PARTIALLY VERIFIED** — moving step 3 after ownership and adding OCR/route/oracle prerequisites is coherent planning, but 1.10 is not a proven dead route and “no Python lane” is unsupported.
- **PARTIALLY VERIFIED** — moving ownership before weight is permissible; the claimed mandatory partial-trim-before-union suborder relies on the incomplete algorithm in 1.9.
- **VERIFIED** — preserving the genuine regression half of `evaluate.rs:1046–1064` corrects 1.2's overbroad test characterization; O6 needs one disposition.
- **PARTIALLY VERIFIED** — keeping supported-class declaration last is a dependency choice, not an empirically forced order.
- **VERIFIED** — inserting durability and ledger reconciliation addresses the post-audit branch commit and ledger staleness, though C1 means S0(a) was already completed before this verification.

### S0 — durability and hygiene

- **PARTIALLY VERIFIED** — “minutes, no dependencies, do first” is a priority/effort estimate, not a reproducible fact; S0(a) was already done and source-host b/c duration is unknown.
- **STALE-NOW** — S0(a), commit/push 491 insertions, is done at `70f0c70ae`. It must not remain an actionable first command.
- **UNVERIFIABLE** — S0(b)'s source-Mac Electron process/session state cannot be inspected here; tracked rule/script contradiction survives.
- **UNVERIFIABLE** — S0(c)'s `.rows` file cannot be independently observed in this isolated worktree.
- **FALSE** — the universal DONE condition is incomplete: 2.10 says load-bearing audit/measurement sources remain only in ignored `.devkit`, and deleting a zero-byte `.rows` file says nothing about load-bearing state.

### S1 — ledger reconciliation

- **PARTIALLY VERIFIED** — making reconciliation a precondition for every later dispatch is a governance preference, not a technical dependency.
- **VERIFIED** — adding R17 with PR #13/#14/#16/#17, landed SHAs, raster/lossless status, and now-successful push attestation is supported.
- **VERIFIED** — reopening S2/S3, rewriting S4, recording G3 timestamps, annotating the batch, relabeling manual gates, correcting the subscription claim, fixing approach drift, and recording X2/batching precedence all follow verified contradictions in 2.2–2.9/2.12/4.8.
- **PARTIALLY VERIFIED** — re-pointing §8 and relocating audit sources requires access to the absent SYNTHESIS/COMPLETENESS-CRITIC files; their asserted topology is not independently verified.
- **PARTIALLY VERIFIED** — S4/S5/S6 dispositions and an owner for nightly failures are supported, while retroactive stay-fixed fields for every R1–R15 row are optional process design.
- **FALSE** — the enumerated S1 cannot satisfy “every number ... recomputable or labelled”: tracking scripts is deferred to S7, 2.6's direct-main decision was omitted in the original list, and current code remediation for the reconnect leak was not an S1 item. `1883e0752` later records some of these decisions but still cites ignored inputs.

### S2 — enforcement decision

- **FALSE** — enforcement is not a technical precondition for *wiring* an oracle. Callers can be added first; protection is a prerequisite only for merge-blocking semantics.
- **VERIFIED** — current required context/force-push/conversation settings are inadequate for a merge-blocking quality aggregate (E8).
- **PARTIALLY VERIFIED** — `gates_ok` as the *single* required status is a reasonable simplification, not the only safe configuration; stable check naming/app identity and bypass/admin rules also matter. The report's `gates_ok/"Quality Gates"` wording is also wrong: job id and display name at `ci.yml:352–354` are both `gates_ok`; “Quality Gates” is a different job.
- **VERIFIED** — if settings changes remain declined, recording visible-red-only semantics is necessary. Extending pre-push can provide local feedback but is not enforcement.
- **VERIFIED** — the proposed DONE dichotomy is testable: red aggregate blocks merge, or governance explicitly records that it does not.

### S3 — wire existing oracles

- **VERIFIED** — S3(a)'s baseline regeneration, denominator assertion, and replacement of only the vacuous assertion address verified gaps. Zero/named-exception policy still needs product adjudication.
- **PARTIALLY VERIFIED** — S3(b) names executing jobs, but `scan-cleanup-preview-harness.mjs --check` also requires tracked `--source`, `--pages`, and `--out` inputs (`parseArgs:204–205`); the sequence names none, so it is not directly implementable as written.
- **PARTIALLY VERIFIED** — S3(c)'s hard-zero/0.01 goals are explicit, but the word-loss audit likewise needs committed fixture/input selection. Current indirect CI use skips and passes `--fail-on none` (4.4).
- **FALSE** — S3(d) repeats 1.5's incomplete remedy. Adding only coverage globs and roots will not select core/adapters files for the zero-execution tripwire; its predicate/load-bearing inventory must also change. The PR-only coverage guard removal is independently supported.
- **PARTIALLY VERIFIED** — S3(e)'s arm64-or-document choice is honest but adding arm64 covers only a second of five shipped platform-arches.
- **PARTIALLY VERIFIED** — deliberate red failure injection and exact-SHA CI records are strong DONE criteria, but cannot be satisfied until stable committed inputs and branch protection semantics are defined.

### S4 — native ownership

- **PARTIALLY VERIFIED** — S4(a)'s thresholding goal is supported, but its specified “partial trim” algorithm does not move a rectangular side while any protected survivor stays at the extreme (1.9).
- **VERIFIED** — S4(b)'s one-owner invariant and regression test directly address the proven post-trim outward union.
- **PARTIALLY VERIFIED** — S4(c)'s reason-carrying FoldBand addresses lost state, but a nominal conservative fallback is not calibrated/proved; abstention is not one of the leaf-fallback causes.
- **PARTIALLY VERIFIED** — S4(d) should integrate/re-adjudicate the rescue branch, but “delete the clamp” is not forced absent a failing specimen; no textual merge conflict currently exists.
- **UNVERIFIABLE** — R10/R12/R12a RED→GREEN results and diagnostic guarantees are future acceptance criteria; no supplied tracked specimens/results prove them now.

### S5 — weight oracle and `bw.rs`

- **PARTIALLY VERIFIED** — treating 1.10 and 1.13 as strict preconditions is conservative planning; route analysis, OCR isolation, and oracle work are technically separable.
- **PARTIALLY VERIFIED** — S5(a) should record route distributions and resolve inconsistent measurement spaces, but 1.10's claimed production unreachability is materially overstated.
- **PARTIALLY VERIFIED** — S5(b) isolates OCR, but needs a declared OCR pixel contract before “full options OCR wants” is determinate.
- **PARTIALLY VERIFIED** — S5(c) correctly requires a tracked runner/fixture and pre-fix red result; excluding Python is unsupported, and ignored script details are unavailable.
- **VERIFIED** — withholding `bw.rs` acceptance until an absolute output-evenness oracle exists follows the mismatch proved in 3.4.
- **UNVERIFIABLE** — RED/GREEN letter-level export runs are future deliverables; they do not currently exist in tracked evidence.

### S6 — deletions

- **VERIFIED** — removal of the unreachable production branches and correction of quarantine policy pins are supported if governing policy chooses the advertised behavior.
- **FALSE** — the workflow-dispatch `Native Rust Tests` job is not a reachability duplicate. The PR job is guarded to pull_request/push (`ci.yml:235–239`), while `manual_native` is the dispatch route (`:458–497`). Deleting it without expanding another job removes manual Rust test/lint/deny coverage. O6 separately requires its unresolved policy decision.
- **VERIFIED** — preserving the genuine evaluate regression assertion is required.
- **UNVERIFIABLE** — “every deletion lands with no gate turning red” is a future test outcome.

### S7 — boundary findings

- **PARTIALLY VERIFIED** — “user-visible first” is a reasonable priority choice, not an evidence-derived dependency across all seven heterogeneous items.
- **PARTIALLY VERIFIED** — S7(a) identifies the lifecycle gap; Recent Files alone is not durable storage and must coordinate with pruning/access.
- **VERIFIED** — S7(b)'s Linux/Windows packaged sidecar execution and named win-arm64 gap follow 1.7.
- **PARTIALLY VERIFIED** — S7(c)'s tracked charter is appropriate if the unavailable CLAUDE premise is confirmed.
- **FALSE** — S7(d) repeats the dangling-source error: it says copy “SYNTHESIS and section 7/8” even though 2.13 says SYNTHESIS ends at §7 and boundary findings live in COMPLETENESS-CRITIC. Copying prose/scripts alone also omits needed fixtures, inputs, versions, and expected results.
- **VERIFIED** — S7(e) correctly offers executable CI with a committed fixture or honest local-only classification.
- **VERIFIED** — S7(f)'s lossless identity work is required before preview evidence can attest export; retro chat-pack absence remains unverified.
- **PARTIALLY VERIFIED** — S7(g) depends on source-Mac inspection for `.devkit`, `.rows`, and local parked branch. The 12 remote merged heads are verified, but deletion needs ownership confirmation.
- **PARTIALLY VERIFIED** — the DONE clause is a sound truthfulness standard, not a present result; some items may intentionally remain documented blind spots.

### S8 — supported document class

- **VERIFIED** — no tracked supported-class declaration exists at the audited/current main.
- **PARTIALLY VERIFIED** — route distribution is useful input but cannot alone define product support; corpus representativeness and product intent are also required.
- **UNVERIFIABLE** — the stated DONE document/routes/out-of-scope list is a future deliverable.

### Closure vocabulary reminder

- **FALSE** — applying RED→GREEN/export/oracle/eyeball requirements “FOR EVERY ITEM ABOVE” is internally impossible for S0 hygiene, S1 ledger edits, S2 settings, S6 control deletion, and S8 documentation. It also conflicts with S2's documented-no-enforcement alternative and S7's explicit-limitation alternative. Scope this bar to user-visible behavioral defect closures.
- **VERIFIED** — defect-granularity and export measurement are necessary for claims specifically about exported visual defects.
- **PARTIALLY VERIFIED** — an “executing caller” is necessary for an automated gate; a deliberately manual diagnostic can still support evidence if honestly labeled, reproducible, and run on the exact SHA.
- **VERIFIED** — exact-SHA recording is necessary to avoid conflating historical and current states.
- **PARTIALLY VERIFIED** — an eyeball pack is the ledger's chosen process rule, not a universal condition for factual closure; chat-only delivery is not independently auditable.
- **VERIFIED** — a number available only from ignored `.devkit` without tracked inputs/script/result does not meet the report's own reproducibility bar.

## Ten highest-impact corrections

1. **Coverage plan cannot work as written (1.5/S3d).** Adding directories to coverage and tripwire roots does not make the tripwire select their files; its target predicate/load-bearing inventory must change. “10,384 lines” is physical LOC, not the V8 denominator.
2. **Proposed partial trim is incomplete (1.9/S4a).** Removing only unprotected side-touching blocks cannot move a rectangular side while a protected survivor remains at the same extreme.
3. **Do not delete manual Rust validation as a “duplicate” (S6).** It is the only workflow-dispatch route; the PR job is skipped for dispatch. Consolidate event reachability first or retain it.
4. **The rescue clamp is appended but not proved harmful (C2/3.2).** It is an inward last-writer, while source exclusion is also consumed earlier. No specimen proves it recreates the outward-union failure; BLOCKER severity is unsupported.
5. **The twelve-landing root-cause claim is unproved (1.1).** The post-trim union can re-expand sides, but no durable per-landing/specimen chain attributes all twelve failures to it; a test intentionally preserves vetted full-picture extent.
6. **Sauvola reachability is materially overstated (1.10).** Scale one is not required; capped production routing can measure 3px; full-size positive-run arithmetic does not establish route death across production inputs.
7. **No-Python constraint is false (4.2/S5c).** CI already installs Pillow and tracked Python diagnostics exist. The problem is absent tracked weight inputs/caller, not inability to run Python.
8. **Pending merge conflict is false (3.3).** Both sides changed `render.rs`, but a read-only three-way merge emits no conflict markers and current tips auto-merge.
9. **Universal closure rule is internally impossible.** Export RED→GREEN and eyeball packs make sense for visual defects, not process cleanup, settings, ledger edits, deletion, or support documentation; it contradicts S2/S7 alternative DONE clauses.
10. **S3's behavioral closure was wrongly repudiated (2.3).** The independent exact-SHA release harness reproduced 51/51 and all-zero catastrophes. Its baseline and CI wiring are stale, but those are S4/governance debt, not evidence that PR #11's behavior claim was false.

Other important corrections: the comparator test is not only self-comparison; “every closure number” is false because O6/fixture counts reproduce; abstention does not reach the fold leaf fallback; C5's process/untracked-file assertions are not commit facts; Recent Files alone is not a retention solution; R12's own ledger text described a preview-phase hypothesis, so grouping it as a proven geometry specimen in S4 is unjustified; 3.5's wrapper has a real harness production caller; Q1 already disclosed its planned state; protocol-6 version smoke cannot detect the optional v3 fold-clip behavior. Separately, run `31840148788` is successful, rescue is committed, and final live main is `cc3748af7` (8/2 divergence, 17 heads).

## Contradictions, disagreements, and severity audit

### Internal contradictions in `REPORT.txt`

- C1 resolves 3.1 and S0(a), but the ordered sequence still presents S0(a) as an action. C3 corrects 3.3's one-ahead count; both are now stale again after current main advanced.
- Baseline says steps 2–6 are absent, while 2.1 says the preview-harness composition subpart of step 2 landed.
- 1.2's headline says the only test is self-comparison, while its own action and 1.14 acknowledge the real mutation assertion that must be retained.
- 2.2 says five files are dirty after C1 says that exact delta was committed/pushed.
- 2.10 requests “SYNTHESIS and section 7/8”; 2.13 says SYNTHESIS has no §8. S7(d) repeats the same error.
- Step-1 disposition calls the missing eyeball pack “not a blocker,” while 2.8 says do not mark the step closed and ledger rules call pack-less closure invalid.
- S1 declares every number recomputable before S7 tracks the scripts/sources required to do so.
- S2 speaks of a “blocking CI job” while its settings-declined branch and current R18 D4 explicitly leave all gates visible-red only.
- S7 DONE permits an explicit limitation instead of an executing red proof; the universal closure reminder permits no such alternative and cannot apply to non-behavior items.
- S4 DONE groups R12 into geometry despite ledger R12 explicitly describing a phase-edge preview hypothesis and saying to verify before concluding.

### Independent-review disagreements and resolution

- Reviewers agreed on C2's structural order but differed on headline verdict. Resolution: the order is **VERIFIED**; behavioral equivalence to RC2/severity is **PARTIALLY VERIFIED**, because the final inward clamp prevents re-expansion and no failing specimen was supplied.
- Reviewers agreed the unsubscribe is discarded but challenged normal-path severity. Navigation owner-end clears subscribers and the retry loop returns on first authorized success. Resolution: duplicate direct subscribe/reconnect remains a real leak, but “every reconnect permanently” and a three-listener multiplier overstate the ordinary path.
- Reviewers differed on whether 4.2 is “unmeasurable.” Resolution: the criterion is currently unexecutable because its source/input is ignored, but promotion can make it measurable and Python is already feasible. The report's language prohibition is false.
- Reviewers agreed on 1.1 mechanism but not causal scope. Resolution: code-level capability is verified; twelve-landings history and BLOCKER headline remain unverifiable.

### Severity not proved by evidence

The `BLOCKER/HIGH` labels in most 2.x and 4.x items describe governance risk rather than a demonstrated current output defect. The strongest product-risk evidence is the unenforced quality aggregate, temporary-output lifecycle, unexecuted packaged sidecars, and preview/export duplication. Even there, the report usually demonstrates exposure, not observed loss/failure probability. The rescue appended clamp, strict sequencing choices, branch-history cleanliness, and documentation discrepancies do not independently justify blocker-level user severity.

## Coverage ledger

Codes: V verified; P partially verified; F false; S stale-now (historically verified); U unverifiable. Multiple codes mean the report identifier contained multiple atomic propositions, each separately verdict-marked above. The corrected-sequence disposition block is listed separately even though it is not one of the user's numbered identifiers.

| Identifier | Atomic verdicts present | Identifier | Atomic verdicts present |
|---|---:|---|---:|
| Baseline correction | V/P/S/U | C1 | V/U |
| C2 | V | C3 | S |
| C4 | S | C5 | P/S/U |
| 1.1 | V/P/U | 1.2 | V/P/F |
| 1.3 | V/P/U | 1.4 | V/P/F/S |
| 1.5 | V/P/F | 1.6 | V/P |
| 1.7 | V/P/F | 1.8 | V/P/U |
| 1.9 | V/F | 1.10 | V/P/F |
| 1.11 | V/P/U | 1.12 | V/P |
| 1.13 | V/P | 1.14 | V/P/U |
| 1.15 | V/P/U | 1.16 | V/P/U |
| 1.17 | P/F/U | 1.18 | V/P/S/U |
| 2.1 | V/P/S | 2.2 | V/P/S |
| 2.3 | V/P/F | 2.4 | V/P |
| 2.5 | V | 2.6 | V/P |
| 2.7 | P/S | 2.8 | V/P/U |
| 2.9 | V/S/U | 2.10 | V/F |
| 2.11 | V/P/U | 2.12 | V/F |
| 2.13 | P/U | 3.1 | S/U |
| 3.2 | V/P | 3.3 | V/P/F |
| 3.4 | V/P | 3.5 | V/P/F/U |
| 4.1 | V/P | 4.2 | V/P/F/U |
| 4.3 | V/P/F | 4.4 | V/P/U |
| 4.5 | V/P | 4.6 | V/P/U |
| 4.7 | V/P | 4.8 | V/P |
| 4.9 | V/P | Disposition | V/P |
| S0 | P/F/S/U | S1 | V/P/F |
| S2 | V/P/F | S3 | V/P/F |
| S4 | V/P/U | S5 | V/P/U |
| S6 | V/F/U | S7 | V/P/F |
| S8 | V/P/U | Closure reminder | V/P/F |

Coverage result: **all 61 required identifier groups are covered** — Baseline; C1–C5; 1.1–1.18; 2.1–2.13; 3.1–3.5; 4.1–4.9; S0–S8; and the closure reminder. The additional disposition block is also covered. No recommendation was silently omitted; future DONE conditions are generally U when they assert an outcome and P/F when the criterion itself is incomplete or internally incompatible.

### Atomic totals

Each leading verdict bullet from “Snapshot and post-audit corrections” through the closure section is counted as one atomic proposition (closely related conjuncts sharing the same verdict remain one row). Reproduction:

```bash
awk 'BEGIN{s=0} /^## Snapshot/{s=1} s && /^- \*\*/ {
  if ($0 ~ /STALE-NOW/) n["STALE-NOW"]++;
  else if ($0 ~ /PARTIALLY VERIFIED/) n["PARTIALLY VERIFIED"]++;
  else if ($0 ~ /UNVERIFIABLE/) n["UNVERIFIABLE"]++;
  else if ($0 ~ /FALSE/) n["FALSE"]++;
  else if ($0 ~ /VERIFIED/) n["VERIFIED"]++
} END {for (k in n) print k, n[k]}' vps-verification.md
```

| Verdict | Count |
|---|---:|
| VERIFIED | 91 |
| PARTIALLY VERIFIED | 83 |
| FALSE | 26 |
| STALE-NOW (historically verified) | 12 |
| UNVERIFIABLE | 28 |
| **Total atomic rows** | **240** |

## Final assessment

At the exact `6ce2f0b61` snapshot, the report gets most raw code locations, commit history, counts, and missing-caller facts right. It is least reliable when converting those facts into singular root causes, mandatory implementation order, or headline severity. The exact harness proves S3 behavior was one important false repudiation. Its corrected plan needs concrete changes before execution: fix tripwire selection, replace the impossible partial-trim prescription, preserve manual-dispatch Rust coverage, allow a tracked Python oracle if appropriate, name committed harness inputs, add a request/result capability smoke because protocol 6 cannot detect missing optional v3 fields, narrow closure vocabulary to behavioral items, and stop treating the rescue clamp as a demonstrated regression without a red specimen.

At final live state, main is `cc3748af7`, rescue is `70f0c70ae`, divergence is 8/2, the exact-SHA run is green, and 17 remote heads exist. The ledger commit records many governance corrections, and PR #18 closes reconnect idempotency on main; other audited production/CI gaps remain.
