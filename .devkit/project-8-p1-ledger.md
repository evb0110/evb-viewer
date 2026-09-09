# Project 8 P1 batch ledger

Started: 2026-09-09T07:40:00Z
Planning target: approximately nine hours, with the final two hours reserved for independent review, combined exact-head gates, publication, terminal hosted CI, and durable receipts.
Worktree: `/home/ubuntu/.t3/worktrees/evb-viewer/t3code-8c180c7d`
Branch: `t3code/project-8-process-safety`
Starting SHA: `34136c0f467ca75fceaff6be46a45357e3847b89`
Base checked: `origin/main` at the same SHA at start.
Scope: issues #370, #371, #381 only. Browser batch #479/#481/#489/#494 and issue #379 remain out of scope.

## Reservations

| Ticket | Implementation owner | Reserved paths | Exclusions |
| --- | --- | --- | --- |
| #370 TH-1 | Luna child | `scripts/electron-run/electronRunNuxtServer.ts`; dedicated process-safety tests | no runCli, session-artifact, legacy migration, #379 |
| #371 TH-2 | Luna child | `scripts/electron-run/electronRunE2ESessionPrune.ts`; session-artifact/shared-cleanup tests | no runCli, legacy migration, #379 |
| #381 TH-12 | Luna child | `scripts/electron-run/runCli.ts`; legacy-dispatch tests | no identity-helper edits, session-artifact cleanup, #379 |
| Integration | parent | shared `electronRunProcessIdentity.ts`, combined tests, gates, review, receipts | no unrelated issues or native refactors |

## Required evidence

- Disposable roots, dynamic ports, harmless subprocesses, recorded identities, and real Unix survival checks.
- Injected identity/PID/start-time/boot races and Windows identity representation tests where supported.
- Exact CLI dispatch and final cleanup paths, not helper-only mocks.
- Hosted platform results recorded without calling Linux proof macOS/Windows proof.
- CodeRabbit and fresh Luna review on the frozen combined diff.

## Worker status

- #370: implementation complete; focused ownership tests 43/43 passed in combined lane; hosted macOS/Windows proof pending
- #371: implementation complete; focused ownership/pruning tests 43/43 passed in combined lane; hosted macOS/Windows proof pending
- #381: implementation complete, focused tests 14/14 passed; Windows/full Electron acceptance pending hosted evidence

## Final receipt

- Reconciled incoming `origin/main` at `8412effa4a9e28f7734cde4e6c35fb0d68cacabb` without source conflicts. Current pre-publication HEAD: `ce86fb8b919a5f4cc1bb7e3a07e8734677aa1a23`.
- Current worktree is clean except ignored generated `.nuxt` output. No real user service, shared T3 process, or other worktree was stopped.
- Hosted macOS/Windows runs were not available from this VPS before publication. Linux results and synthetic Windows identity cases are recorded as local evidence only, not cross-platform proof. The applicable hosted obligations remain open.
- Project item and issue evidence comments remain to be published after the normal main push.

## Review evidence

CodeRabbit pass 1 reviewed the seven-file uncommitted scope at the starting-head worktree. It returned seven findings. Dispositions: fixed the major malformed-sibling ownership classification in `electronRunSessionArtifacts.ts`; fixed the two sound TH-1/TH-2 test reliability/assertion findings; restored shared `getErrorMessage` formatting in the prune path. Declined the `linkSync` suggestion because same-directory `renameSync` is atomic and preserves a stronger interruption-recovery boundary. The dead-PID fixture suggestion was not required because the stopped subprocess proves a real PID transition and the test remains harmless. Follow-up review is required for the changed candidate.

CodeRabbit pass 2 reviewed the same seven-file scope after those fixes. It returned seven findings. Fixed the sound startup-state handoff, injected-probe consistency, legacy diagnostic/actionability, and modern-session output assertions. The two test major findings were fixed by asserting descendant termination and gating the PID-1 orphan fixture with its existing systemd capability check. No third CodeRabbit pass was used under the two-pass limit. Four shared caller files were then changed in response to the independent Luna review and remain outside CodeRabbit's reviewed file set. They are covered by the final Luna review and exact local gates.

## Local gates

- Affected ESLint: passed after the final integration fixes.
- `tsc -p tsconfig.scripts.json --noEmit`: passed.
- Focused six-file process-safety lane: 43 passed.
- Full `vitest run --project unit-scripts --reporter dot`: 189 files passed, 3 skipped; 1,514 tests passed, 12 skipped. The Vite native-config notices are repository warnings.
- Generated `.nuxt` output remains ignored and belongs to this worktree only. No user service or other worktree process was stopped.

An independent Luna review of the pre-merge combined diff found the shared cleanup and migration issues listed in its report. Those findings were fixed, and the affected plus full local gates were rerun. A second fresh Luna review was started against the corrected diff but did not reach a terminal result during the available wait and was closed as unavailable. No approval is claimed for that second review.
