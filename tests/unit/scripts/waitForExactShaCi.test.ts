import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    defaultCommandRunner,
    EXACT_SHA_CI_APPEARANCE_TIMEOUT_MS,
    EXACT_SHA_CI_COMPLETION_TIMEOUT_MS,
    findLatestMatchingRun,
    listSuccessfulMainPushRuns,
    waitForExactShaCiGates,
} from '@scripts/release/wait-for-exact-sha-ci.mjs';

const TARGET_SHA = 'a'.repeat(40);
const PARENT_SHA = 'b'.repeat(40);
const RUN_URL = 'https://github.com/evb0110/evb-viewer/actions/runs/424242';
const PARENT_RUN_URL = 'https://github.com/evb0110/evb-viewer/actions/runs/313131';
// The stale budget that failed release run 32691744074 three seconds before
// its gates_ok completed (issue #109). The regression scenario below crosses
// it deliberately.
const OLD_STALE_BUDGET_MS = 45 * 60_000;

interface IScriptedMinute {
    status: 'in_progress' | 'completed' | 'absent';
    conclusion?: string;
    event?: 'push' | 'workflow_dispatch';
    gatesOk?: string;
}

// Deterministic virtual-clock harness: each poll advances the clock by the
// poll interval; the scripted timeline decides what the CI API reports at
// each minute. No real sleeping, no network.
function createHarness(timeline: (elapsedMs: number) => IScriptedMinute) {
    let now = 0;
    const pollTimes: number[] = [];
    const nowFn = () => now;
    const sleepFn = async (ms?: number) => {
        now += ms ?? 0;
    };
    const runCommand = (command: string, args: string[]) => {
        const spec = args.join(' ');
        const frame = timeline(now);
        if (command === 'git' && spec.includes('rev-parse --verify --quiet')) {
            return PARENT_SHA;
        }
        if (command === 'git' && spec.includes('diff --numstat')) {
            return '5\t5\tsrc/feature.ts\n';
        }
        if (command === 'git' && spec.includes('fetch --depth=2')) {
            return '';
        }
        if (spec.includes('/runs?head_sha=')) {
            pollTimes.push(now);
            if (frame.status === 'absent') {
                return JSON.stringify({workflow_runs: []});
            }
            return JSON.stringify({workflow_runs: [{
                conclusion: frame.status === 'completed' ? frame.conclusion ?? 'success' : null,
                event: frame.event ?? 'push',
                head_branch: 'main',
                head_sha: TARGET_SHA,
                html_url: RUN_URL,
                id: 424242,
                run_number: 7,
                status: frame.status,
            }]});
        }
        if (spec.includes('/jobs?per_page=100')) {
            return frame.gatesOk ?? '';
        }
        throw new Error(`Unexpected command in harness: ${spec}`);
    };
    return {
        nowFn,
        pollTimes,
        runCommand,
        sleepFn,
        stderr: {write: () => true},
    };
}

function createParentVerificationHarness({
    parentEvent = 'push',
    parentGates = 'success',
    parentStatus = 'completed',
    parentConclusion = 'success',
    numstat = '1\t1\tpackage.json\n',
    diff = [
        'diff --git a/package.json b/package.json',
        '--- a/package.json',
        '+++ b/package.json',
        '@@ -4 +4 @@',
        '-  "version": "0.1.445",',
        '+  "version": "0.1.446",',
    ].join('\n'),
    parentObjectMissing = false,
    parentRunMissing = false,
} = {}) {
    let now = 0;
    let parentLookupAttempts = 0;
    const commands: string[] = [];
    const runCommand = (command: string, args: string[]) => {
        const spec = args.join(' ');
        commands.push(`${command} ${spec}`);
        if (command === 'gh' && spec.includes('/runs?head_sha=')) {
            if (spec.includes(`head_sha=${TARGET_SHA}`)) {
                return JSON.stringify({workflow_runs: []});
            }
            if (spec.includes(`head_sha=${PARENT_SHA}`)) {
                return JSON.stringify({workflow_runs: [{
                    conclusion: parentConclusion,
                    event: parentEvent,
                    head_branch: 'main',
                    head_sha: PARENT_SHA,
                    html_url: PARENT_RUN_URL,
                    id: 313131,
                    run_number: 6,
                    status: parentStatus,
                }].filter(() => !parentRunMissing)});
            }
        }
        if (command === 'gh' && spec.includes('/jobs?per_page=100')) {
            return parentGates;
        }
        if (command === 'git' && spec.includes('rev-parse --verify --quiet')) {
            parentLookupAttempts += 1;
            if (parentLookupAttempts === 1 && parentObjectMissing) {
                throw new Error('unknown revision');
            }
            return PARENT_SHA;
        }
        if (command === 'git' && spec.includes('diff --numstat')) {
            return numstat;
        }
        if (command === 'git' && spec.includes('diff -U0')) {
            return diff;
        }
        if (command === 'git' && spec.includes('fetch --depth=2')) {
            return '';
        }
        throw new Error(`Unexpected command in parent harness: ${command} ${spec}`);
    };

    return {
        commands,
        nowFn: () => now,
        runCommand,
        sleepFn: async (duration: number) => {
            now += duration;
        },
        stderr: {write: () => true},
    };
}

describe('waitForExactShaCiGates', () => {
    it('uses the short appearance window for parent verification', () => {
        expect(EXACT_SHA_CI_APPEARANCE_TIMEOUT_MS).toBe(60_000);
    });

    it('waits past the old stale budget for a run that finishes late and green', async () => {
        const lateSuccessAtMs = OLD_STALE_BUDGET_MS + 60_000;
        expect(EXACT_SHA_CI_COMPLETION_TIMEOUT_MS).toBeGreaterThan(lateSuccessAtMs);
        const harness = createHarness(elapsedMs => (elapsedMs < lateSuccessAtMs
            ? {status: 'in_progress'}
            : {
                conclusion: 'success',
                gatesOk: 'success',
                status: 'completed',
            }));

        await expect(waitForExactShaCiGates(TARGET_SHA, harness)).resolves.toEqual({
            id: 424242,
            url: RUN_URL,
        });
        expect(Math.max(...harness.pollTimes)).toBeGreaterThanOrEqual(lateSuccessAtMs);
    });

    it('accepts a skipped-CI release commit after its version-only parent is green', async () => {
        const harness = createParentVerificationHarness();

        await expect(waitForExactShaCiGates(TARGET_SHA, {
            ...harness,
            appearanceTimeoutMs: 0,
        })).resolves.toEqual({
            id: 313131,
            parentSha: PARENT_SHA,
            url: PARENT_RUN_URL,
            verifiedByParent: true,
        });
        expect(harness.commands.some(command => command.includes(`head_sha=${PARENT_SHA}`))).toBe(true);
    });

    it('fetches the parent when the checkout is shallow', async () => {
        const harness = createParentVerificationHarness({parentObjectMissing: true});

        await expect(waitForExactShaCiGates(TARGET_SHA, {
            ...harness,
            appearanceTimeoutMs: 0,
        })).resolves.toMatchObject({
            parentSha: PARENT_SHA,
            verifiedByParent: true,
        });
        expect(harness.commands).toContain(`git fetch --depth=2 origin ${TARGET_SHA}`);
    });

    it('fails closed and names the parent when the parent has no CI run', async () => {
        const harness = createParentVerificationHarness({parentRunMissing: true});
        await expect(waitForExactShaCiGates(TARGET_SHA, {
            ...harness,
            appearanceTimeoutMs: 0,
        })).rejects.toThrow(new RegExp(`No CI run appeared for release parent ${PARENT_SHA}`, 'u'));
    });

    it('rejects a target whose diff is not exactly one package.json version line', async () => {
        const harness = createParentVerificationHarness({numstat: '2\t1\tpackage.json\n'});

        await expect(waitForExactShaCiGates(TARGET_SHA, {
            ...harness,
            appearanceTimeoutMs: 0,
        })).rejects.toThrow(/not a version-only package\.json commit/u);
    });

    it('rejects a red parent run', async () => {
        const harness = createParentVerificationHarness({parentConclusion: 'failure'});

        await expect(waitForExactShaCiGates(TARGET_SHA, {
            ...harness,
            appearanceTimeoutMs: 0,
        })).rejects.toThrow(/parent.*concluded 'failure'/u);
    });

    it('rejects a parent without a successful gates_ok aggregate', async () => {
        const harness = createParentVerificationHarness({parentGates: 'failure'});

        await expect(waitForExactShaCiGates(TARGET_SHA, {
            ...harness,
            appearanceTimeoutMs: 0,
        })).rejects.toThrow(/parent.*did not contain a successful gates_ok/u);
    });

    it('rejects a cancelled parent and names the rerun that would give it a verdict', async () => {
        const harness = createParentVerificationHarness({parentConclusion: 'cancelled'});

        await expect(waitForExactShaCiGates(TARGET_SHA, {
            ...harness,
            appearanceTimeoutMs: 0,
        })).rejects.toThrow(/concluded 'cancelled'.*gh run rerun 313131/u);
    });

    it('judges a version-only release commit by its parent at once, without polling for its own run', async () => {
        const harness = createParentVerificationHarness();

        await expect(waitForExactShaCiGates(TARGET_SHA, harness)).resolves.toMatchObject({
            id: 313131,
            verifiedByParent: true,
        });
        expect(harness.commands.some(command => command.includes(`head_sha=${TARGET_SHA}`))).toBe(false);
        expect(harness.nowFn()).toBe(0);
    });

    it('lists successful main push runs newest first from the conclusion-filtered query', () => {
        const runs = listSuccessfulMainPushRuns((_command: string, args: string[]) => {
            expect(args.join(' ')).toContain('runs?branch=main&event=push&status=success&per_page=30');
            return JSON.stringify({workflow_runs: [
                {
                    conclusion: 'success',
                    event: 'push',
                    head_branch: 'main',
                    head_sha: PARENT_SHA,
                    id: 1,
                    run_number: 5,
                },
                {
                    conclusion: 'success',
                    event: 'workflow_dispatch',
                    head_branch: 'main',
                    head_sha: TARGET_SHA,
                    id: 2,
                    run_number: 7,
                },
                {
                    conclusion: 'success',
                    event: 'push',
                    head_branch: 'main',
                    head_sha: TARGET_SHA,
                    id: 3,
                    run_number: 6,
                },
            ]});
        });

        expect(runs.map(runInfo => runInfo.id)).toEqual([
            3,
            1,
        ]);
    });

    it('stops when the exact target run was cancelled', async () => {
        const harness = createHarness(() => ({
            conclusion: 'cancelled',
            status: 'completed',
        }));

        await expect(waitForExactShaCiGates(TARGET_SHA, harness))
            .rejects.toThrow(/run 424242 .*was cancelled, so it has no verdict/u);
    });

    it('fails promptly with the actual conclusion when the run turns terminal red', async () => {
        const harness = createHarness(elapsedMs => (elapsedMs < 5 * 60_000
            ? {status: 'in_progress'}
            : {
                conclusion: 'failure',
                status: 'completed',
            }));

        await expect(waitForExactShaCiGates(TARGET_SHA, harness))
            .rejects.toThrow(/run 424242 .*concluded 'failure'/u);
        expect(Math.max(...harness.pollTimes)).toBeLessThan(7 * 60_000);
    });

    it('reports a known run that exceeded the deadline, polling at the boundary', async () => {
        const harness = createHarness(() => ({status: 'in_progress'}));

        await expect(waitForExactShaCiGates(TARGET_SHA, harness))
            .rejects.toThrow(/run 424242 .*did not reach a terminal state within 100 minutes/u);
        expect(Math.max(...harness.pollTimes)).toBeGreaterThanOrEqual(EXACT_SHA_CI_COMPLETION_TIMEOUT_MS);
    });

    it('reports a successful run whose gates_ok aggregate is not green', async () => {
        const harness = createHarness(() => ({
            conclusion: 'success',
            gatesOk: 'failure',
            status: 'completed',
        }));

        await expect(waitForExactShaCiGates(TARGET_SHA, harness))
            .rejects.toThrow(/did not contain a successful gates_ok aggregate \(saw 'failure'\)/u);
    });

    it('keeps waiting through transient CI lookup failures', async () => {
        let calls = 0;
        const base = createHarness(elapsedMs => (elapsedMs < 2 * 60_000
            ? {status: 'in_progress'}
            : {
                conclusion: 'success',
                gatesOk: 'success',
                status: 'completed',
            }));
        const flakyRunCommand = (command: string, args: string[]) => {
            calls += 1;
            if (calls === 1) {
                throw new Error('api unavailable');
            }
            return base.runCommand(command, args);
        };

        await expect(waitForExactShaCiGates(TARGET_SHA, {
            ...base,
            runCommand: flakyRunCommand,
        })).resolves.toMatchObject({id: 424242});
    });

    it('filters CI runs to main push events', () => {
        const runs = JSON.stringify({workflow_runs: [
            {
                event: 'schedule',
                head_branch: 'main',
                head_sha: TARGET_SHA,
                id: 1,
                run_number: 99,
            },
            {
                event: 'workflow_dispatch',
                head_branch: 'main',
                head_sha: TARGET_SHA,
                id: 2,
                run_number: 2,
            },
            {
                event: 'push',
                head_branch: 'main',
                head_sha: TARGET_SHA,
                id: 3,
                run_number: 1,
            },
        ]});

        expect(findLatestMatchingRun(TARGET_SHA, () => runs)?.id).toBe(3);
    });

    it('binds the default command runner to the same (command, args) contract as the harness', () => {
        expect(defaultCommandRunner('node', [
            '-e',
            'process.stdout.write("runner-contract-ok")',
        ])).toBe('runner-contract-ok');
    });
});
