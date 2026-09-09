# Project 6 #296 baseline decision for #300

Date: 2026-09-08

This is a decision artifact, not completion of #296 or #300. It records the
line-budget evidence available from the assigned integration worktree and the
fresh target-host `origin/main`.

## Inspected identity

- Assigned worktree: `/Users/evb/.t3/worktrees/t3code-12a360ed/t3code-9c3e5c6c`
- Project: `6b0c8150-d5c2-4b91-bd94-34f3c2e33f69`
- Branch: `t3code/scan-cleanup-package-consolidation`
- Git common directory: `/Users/evb/WebstormProjects/evb-viewer/.git`
- Worktree HEAD: `abfdcc9b018f2e6f05be4026d9f931e2b50eba7a`
- User-supplied integration candidate: `ae9a56bcce8c981afe37c98830878a88ff12abbf`
- Refreshed `origin/main`: `e447d231b6080391427890a2bd42e6a2cca663a4`
- Historical #296 baseline commit: `b4b6b44135dce544489989caecb9250ab8078359`
- Preserved recovery ref: `refs/codex/project6-300-pre-rebase-abfd-441` at `abfdcc9b018f2e6f05be4026d9f931e2b50eba7a`

The assigned worktree was clean before and after analysis. The branch was not
rebased. Its history contains the #300 candidate plus other integrated Project
6 work, while `origin/main` is a different line of history. Replaying that
branch would not isolate #300 commits safely.

## Commands and evidence

The following read-only commands were used:

```text
git fetch origin main
git rev-parse HEAD origin/main
git symbolic-ref --short HEAD
git rev-parse --path-format=absolute --git-common-dir
git status --short
git merge-base b4b6b44135dce544489989caecb9250ab8078359 origin/main
git log --reverse --first-parent b4b6b44135dce544489989caecb9250ab8078359..origin/main
git diff --numstat b4b6b44135dce544489989caecb9250ab8078359 origin/main -- <scan-cleanup homes>
git diff --name-only b4b6b44135dce544489989caecb9250ab8078359 origin/main -- <scan-cleanup homes>
# Historical line counts were gathered before the numerical requirement was retired.
```

The merge-base of the fixed baseline and `origin/main` is the fixed baseline
itself. The first-parent history shows the native #298/#299 integration sequence,
then the Project 4 annotation changes ending at `e447d231b6080391427890a2bd42e6a2cca663a4`.
The target ref still owns the historical `scan-cleanup-core/` and
`scan-cleanup-adapters/` paths. The package move is present in the assigned #300
candidate, not in this target ref.

The raw path comparison from `b4b6b441` to `origin/main` found 28 production-home
paths, with 17,798 added and 11,897 deleted lines by Git numstat. That raw number
is not the gate result because the native refactor moves test support inside Rust
files and the package move is not present at this target ref.

The requested cfc1 comparison found 1,240 changed paths, 96,240 additions and
107,943 deletions. During final verification, `origin/main` advanced to
`e447d231`; that commit changes only unrelated PDF-viewer files, so the refreshed
comparison is 1,242 paths, 96,243 additions, and 107,953 deletions. Six vendor
paths include the checked-in PDF.js archives and
receipts. Two generated paths contribute 12 textual lines. These are not
scan-cleanup production growth. Annotation integration paths account for the
large unrelated annotation/PDF round-trip changes after the native Project 6
work; they are outside the six #296 homes.

## Fixed baseline and current measurements

The verified #296 commit `b4b6b441` records the fixed production ceiling:

| Home | Fixed baseline |
| --- | ---: |
| `app/modules/scan-cleanup` | 16,825 |
| `electron/features/scan-cleanup` | 6,159 |
| `packages/contracts/scan-cleanup` | 5,653 |
| `scan-cleanup-core` | 14,250 |
| `scan-cleanup-adapters` | 1,045 |
| `native/scan-cleanup` | 34,828 |
| Production total | 78,760 |

The #296 production total and native figures are also recorded in the verified
issue evidence. The line counter excludes blanks and comments for TypeScript,
Vue, and Rust, counts inline Rust test code separately, includes tracked files
with max-line suppressions, and reports tests without allowing test growth to
pass production growth.

The refreshed current-main hard-gate evidence from the same counter, evaluated
against `origin/main=e447d231b6080391427890a2bd42e6a2cca663a4`, is:

- Current target app production: 16,825.
- Current target Electron production: 6,159.
- Current target contracts production: 5,653.
- Current target core production: 14,250.
- Current target adapters production: 1,045.
- Current target native production: 38,229.
- Current target production total: 82,161.
- Fixed production baseline: 78,760.
- Current checker delta: +3,401.
- Current target tests: 89,882 code lines across 144 files, reported separately.

The cfc1 scanner recomputation produced the normal hard-gate result. The later
`e447d231` ref has no scan-cleanup diff from cfc1, so these counts and the failure
remain unchanged at the final fetched ref:

```text
# Historical checker output, retained for the decision record only:
  app: 16825 (baseline 16825, delta 0)
  electron: 6159 (baseline 6159, delta 0)
  contracts: 5653 (baseline 5653, delta 0)
  core: 14250 (baseline 14250, delta 0)
  adapters: 1045 (baseline 1045, delta 0)
  native: 38229 (baseline 34828, delta 3401)
  production total: 82161 (baseline 78760, delta 3401)
  tests: 89882 code lines across 144 files (reported separately)
  baseline base ref: origin/main
Error: Scan-cleanup line budget exceeded: native grew by 3401 code lines
(38229 > 34828); production total grew by 3401 code lines (82161 > 78760)
```

The direct command in the mixed #300 worktree was also rerun against the
refreshed ref. Its values are candidate values, not current-main values:

```text
app 16825, electron 7594, contracts 5653, core 14386, adapters 1050,
native 38090, production total 83598, tests 93580 across 159 files
```

The native #299 inventory below is ticket evidence from the historical
`441aec95` snapshot. The refreshed `cfc1ac2` tree has no scan-cleanup diff from
`441aec95`, so those frozen comparisons remain unchanged as historical ticket
evidence. They are not substituted for the current-main scanner output above.

- Historical #299 inventory native production: 38,229.
- Fixed native baseline: 34,828.
- Historical inventory native delta: +3,401.
- Historical inventory production total: 82,166.
- Fixed production baseline: 78,760.
- Historical inventory production delta: +3,406.

The two frozen native ticket comparisons are useful attribution evidence:

- #298 frozen candidate: 258 native lines below the prior target inventory, or 37,971.
- #299 frozen candidate: 5 native lines above the prior target inventory, or 38,234.

The assigned #300 candidate `abfdcc9b` reports 83,598 production lines against
78,760, a delta of +4,838, with these home counts:

| Home in the #300 candidate | Candidate | Baseline | Delta |
| --- | ---: | ---: | ---: |
| app | 16,825 | 16,825 | 0 |
| electron | 7,594 | 6,159 | +1,435 |
| contracts | 5,653 | 5,653 | 0 |
| core | 14,386 | 14,250 | +136 |
| adapters | 1,050 | 1,045 | +5 |
| native | 38,090 | 34,828 | +3,262 |
| Production total | 83,598 | 78,760 | +4,838 |

These are separate snapshots. The assigned worktree is not a substitute for
fresh `origin/main`, and the supplied `ae9a56bc` candidate is not its current
HEAD. The differing native totals are therefore not summed together.

## Attribution and ownership

| Evidence | Attribution | Decision relevance |
| --- | --- | --- |
| `6c27b092`, `d6e2124f`, `4d145e91`, `fe9486c9`, `b4b6b441` | #296 line-budget owner, Eugene Barsky, Mac integration lane | Defines the counter, fixed ceiling, baseline file, explicit override, and regression tests. No baseline edit is justified here. |
| #298 issue evidence, source-approved `7b7633d6420f619fb9a32e66fe5841eedef3fc63` | VPS T3 owner, thread `410c24cf-be7f-497f-a26c-c5c0dafe401f` | Frozen native candidate is 258 lines below current target. Its numerical reduction target is reporting-only, but the resulting current-main production growth remains subject to #296. |
| #299 issue evidence, source-approved `e93682126c1df8c9d186f077120a8357ce228561`, combined candidate `8ee209e0eb628301e06067446f64757eccd00758` | VPS T3 owner, thread `ed9d0d0f-a56b-4d4c-9872-0f55c6433f0d` | The accepted structural split contributes the reported +5 native lines over current target. Project 4 owns the heavy VPS slot and remains an external reservation. |
| #300 source candidate `2e3419945d78d6267a04c49758a50e602ea0ef52`, corrections `1305a253` and `abfdcc9b` | Mac Luna owner, thread `9c3e5c6c-989e-42b9-ad4d-880cc79ff8f9` | The package move accounts for the named core +136 and adapters +5 in the candidate. A consolidation override could only rebalance these homes after total production growth is removed. |
| #301 integrated evidence around `04dfbc141ba394dc20a62f3864535c3e0c2829b3` | Protocol owner | Protocol and capability work is reserved from #300. It is not a justification for changing the #296 baseline. |
| #302 integrated source `4468f17a2501700d7b11817fef3cabc5751109f5` | Mac DjVu owner, thread `0ce51915-8a55-4256-978f-05e557776d7d` | Electron DjVu and PR #349 checker handoffs are outside scan-cleanup homes and must not be charged to #300. |
| #319 issue evidence | Shared tooling owner, with Project 4 holding reserved files | Test-file ceiling and allowlist work is a separate hard control. Test totals are reported separately by #296 and do not justify a production baseline increase. |

The first-parent history attributes the integrated native and render changes to
Eugene Barsky's integration commits. The issue evidence identifies the VPS
threads as the actual #298/#299 owners. Attribution of the +1,435 electron lines
in the assigned #300 candidate to a single ticket is uncertain because the
worktree contains several integrated Project 6 commits. The integrator must
resolve that delta from the exact integrated commit list rather than assigning
it to #300 by proximity.

## Invariant decision

#296 formerly enforced a fixed historical ceiling for production scan-cleanup code.
Normal commits may lower the committed baseline. A consolidation commit may
raise individual named-home baselines only through the explicit consolidation
override, with the base ref, previous identity, current identity, reason, and
job-log echo validated by source and tests. The production total cannot increase
through that override.

The former invariant was pinned by a line-budget script and its tests. Project
6 policy now retires that numerical requirement. The measurements and
scenario inventory remain useful historical evidence, but they are not a
publication gate and must not be restored as one.

Decision at the time: the measured growth required reductions under the then
active policy. That policy is now retired by #296 and #319. The figures below
remain historical reporting, not a current integration blocker. No baseline,
counting rule, test, or gate should be restored from this report.

## Measured reduction plan and handoff

1. Historical handoff for #298/#299: account for the measured +3,401 native
   lines against the former 34,828 ceiling. The path-level scope was
   `native/scan-cleanup/src/adapters/batch_cli.rs` and the extracted
   `native/scan-cleanup/src/engine/**` modules and tests. Preserve output bytes,
   corpus identity, and meaningful stage coverage. The reported #298 and #299
   numerical targets remain reporting targets. The former #296 total is
   historical evidence and no longer blocks verification.

2. #297/source owner and integrator: attribute and reduce the +1,435
   `electron/features/scan-cleanup` growth present in the assigned candidate.
   This report cannot safely assign those lines to #300 because the branch
   contains integrated Project 6 work. The named handoff is the integrator's
   current-main diff review, with the existing owner reservations preserved.

3. #300 owner and integrator: remove avoidable production lines in
   `packages/scan-cleanup/core/**` (+136) and
   `packages/scan-cleanup/adapters/**` (+5) where behavior remains unchanged.
   If the final production total is first reduced to no more than 78,760, use
   one explicit consolidation override to move the baseline path identity from
   `scan-cleanup-core`/`scan-cleanup-adapters` to the package homes. Keep
   `productionTotal` at 78,760 or lower and preserve the existing tests that
   reject total growth and validate the override identity.

4. No reduction is assigned to app or contracts, which are at their fixed
   counts in the candidate. Do not charge tests, vendor archives, generated
   artifacts, annotation changes, DjVu/PR #349 files, #301 protocol files, or
   Project 4 reserved files to #300.

The proposed strict-reconciliation commit was conditional historical work. The
current policy retires the numerical gate, so no baseline reconciliation or
reduction is required.

## Handoff

This section records the historical handoff only. Preserve the measurements
and ownership notes, but do not revive the retired baseline, counter, or size
gates, and do not use #297/#319 numerical targets as publication criteria.
