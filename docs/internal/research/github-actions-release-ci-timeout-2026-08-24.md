# Release verifier timeout investigation

Date: 2026-08-24

Repository: `evb0110/evb-viewer`

Tracking issue: [#109](https://github.com/evb0110/evb-viewer/issues/109)

## Question

Why did release run [32691744074](https://github.com/evb0110/evb-viewer/actions/runs/32691744074), job [97326528969](https://github.com/evb0110/evb-viewer/actions/runs/32691744074/job/97326528969), fail while waiting for exact-SHA CI? Is the failure a one-time GitHub delay or a repeatable problem in the release design?

## Verdict

This is a systemic release-orchestration problem. The release workflow has a fixed wait based on an obsolete 33 to 34 minute CI measurement. Current native/build CI commonly takes 45 to 49 minutes. The failed release stopped three seconds before the matching CI run completed its successful `gates_ok` job.

The workflow failed closed. It did not publish an unverified commit. A second release attempt after CI completion should pass the exact-SHA preflight, but needing that retry is the defect.

## Sources and method

The investigation used first-party records only:

- GitHub Actions run and job metadata fetched through the GitHub REST API and `gh`.
- The immutable logs for the failed release job and its matching CI jobs.
- Workflow and test source at target commit [`a4d6725f4`](https://github.com/evb0110/evb-viewer/commit/a4d6725f46a6c9a2f97c72a5c2032f638ff85215).
- Workflow history, including the commit that added the real-corpus gate to blocking CI.

The timing sample covers six observed runs in which `Native And Build Safety` completed and the overall CI duration reached at least 40 minutes after the real-corpus gate landed. It is enough to establish recurrence, but it is not an exhaustive census of every repository run.

## Exact timeline

| Event | UTC | Evidence |
| --- | --- | --- |
| Matching push CI created | 04:55:14 | [CI run 32691743689](https://github.com/evb0110/evb-viewer/actions/runs/32691743689) |
| Release run created | 04:55:15 | [Release run 32691744074](https://github.com/evb0110/evb-viewer/actions/runs/32691744074) |
| Release exact-SHA verification started | 04:55:41 | [Resolve Target job 97326528969](https://github.com/evb0110/evb-viewer/actions/runs/32691744074/job/97326528969) |
| `Native And Build Safety` completed successfully | 05:40:45 | [CI job 97326599120](https://github.com/evb0110/evb-viewer/actions/runs/32691743689/job/97326599120) |
| Release verifier emitted its timeout | 05:40:48 | [Resolve Target job 97326528969](https://github.com/evb0110/evb-viewer/actions/runs/32691744074/job/97326528969) |
| `gates_ok` completed successfully | 05:40:51 | [CI job 97333681514](https://github.com/evb0110/evb-viewer/actions/runs/32691743689/job/97333681514) |

The matching CI run took 45 minutes 38 seconds from creation through its final update. The release verifier stopped after about 45 minutes 7 seconds in its polling step. Its final error preceded successful `gates_ok` completion by three seconds.

A deterministic retrospective comparison reproduces the incident:

```text
RED: gates_ok completed at 2026-08-24T05:40:51Z, after release cutoff 2026-08-24T05:40:48Z
```

The same target now passes the workflow's exact-SHA conditions because run `32691743689` is terminal, successful, and contains a successful `gates_ok`:

```text
GREEN: target a4d6725f46a6c9a2f97c72a5c2032f638ff85215 now passes exact-SHA CI run 32691743689 and gates_ok
```

## Failure mechanism

The [release polling loop](https://github.com/evb0110/evb-viewer/blob/a4d6725f46a6c9a2f97c72a5c2032f638ff85215/.github/workflows/release.yml#L137-L174) says CI takes about 33 to 34 minutes and performs 90 polls separated by 30-second sleeps. Attempt 90 exits immediately if the run is still in progress. There are only 89 sleep intervals before that last poll, so the nominal 45-minute description also has a boundary shortfall.

The release commit changed only `package.json`. The [Changed Area Detection job](https://github.com/evb0110/evb-viewer/actions/runs/32691743689/job/97326525046) classified that file as `native_or_build=true`. This is intentional policy, so ordinary version bumps run the long native/build lane.

The [native/build job](https://github.com/evb0110/evb-viewer/blob/a4d6725f46a6c9a2f97c72a5c2032f638ff85215/.github/workflows/ci.yml#L290-L352) has a 60-minute job timeout. Commit [`d903155a1`](https://github.com/evb0110/evb-viewer/commit/d903155a11ff68338da2e9103bb3edcdaf158723) added `Scan-cleanup real-corpus tests` to that lane on 2026-08-23, after the release workflow's 45-minute assumption was written. The aggregate `gates_ok` job cannot start until every required lane reaches a terminal state.

The topology test [pins `seq 1 90` and the `within 45 minutes` error text](https://github.com/evb0110/evb-viewer/blob/a4d6725f46a6c9a2f97c72a5c2032f638ff85215/tests/unit/scripts/ciTopologyPolicy.test.ts#L867-L868). It protects a literal duration, not the invariant that the release deadline must exceed the blocking CI graph's maximum.

## Recurrence evidence

Five of the six observed long native/build runs exceeded 45 minutes:

| CI run | Result | Total duration |
| --- | --- | ---: |
| [32644028425](https://github.com/evb0110/evb-viewer/actions/runs/32644028425) | failure | 45:19 |
| [32646513245](https://github.com/evb0110/evb-viewer/actions/runs/32646513245) | success | 49:01 |
| [32671885309](https://github.com/evb0110/evb-viewer/actions/runs/32671885309) | success | 44:57 |
| [32676043683](https://github.com/evb0110/evb-viewer/actions/runs/32676043683) | failure | 48:07 |
| [32689071629](https://github.com/evb0110/evb-viewer/actions/runs/32689071629) | failure | 49:08 |
| [32691743689](https://github.com/evb0110/evb-viewer/actions/runs/32691743689) | success | 45:38 |

Both successful and failed CI runs cross the release cutoff. A successful run causes a false release failure. A failed run that completes after the cutoff causes the release workflow to report a timeout instead of the actual CI conclusion.

## Hypotheses tested

1. **Stale fixed timeout plus final-poll boundary. Confirmed.** The source hard-codes the old timing assumption, the current run completed just after the cutoff, and five of six observed long runs exceeded 45 minutes.
2. **The run filter missed the matching push run. Ruled out as the failure mechanism at the cutoff.** Run `32691743689` was created one second before the release run, has the exact target SHA and `event=push`, and remained in progress until after the cutoff. No filter failure is needed to explain the recorded timing.
3. **GitHub status propagation lag alone caused the failure. Ruled out as the primary cause.** `gates_ok` completed after the release verifier stopped, not before it. API propagation could add delay, but none is needed to explain this failure.
4. **Protected-main ancestry or target mismatch caused the failure. Ruled out.** The ancestry check passed, and both workflows recorded the same target SHA.

## Impact and scope

The defect blocks normal release cuts and wastes an operator retry. It does not weaken validation or publish bad code. The repair belongs in the release wait logic and its topology test. Removing exact-SHA validation, bypassing `gates_ok`, or demoting the native gates would fix the symptom by discarding the safety property and should remain out of scope.

Issue [#109](https://github.com/evb0110/evb-viewer/issues/109) records the implementation contract. The central requirement is to wait for the known exact-SHA run to reach a terminal state within a deadline that covers the declared blocking job bounds, runner queue time, and the aggregate job. The fix also needs a final boundary poll and separate errors for no run, a known run exceeding its deadline, a failed run, and a missing or failed `gates_ok`.

## Limitations

- The historical sample is six long native/build runs, not every CI run in the repository.
- The investigation did not rerun the release workflow because a rerun changes external state and was not needed to prove the timing defect.
- This work diagnosed and tracked the problem. It did not modify workflow code.
