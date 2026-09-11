import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { BrowserDurableDjvuJobs } from '@app/platform/browser-api/browserDurableDjvuJobs';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {
    requireJobId,
    requireRequestId,
} from '@contracts/shared';
import {requireEpochMs} from '@contracts/timestamps';

function installNumericTimerHarness() {
    let nextTimerId = 1;
    const callbacks = new Map<number, () => void>();
    const pendingTimerIds = new Set<number>();
    const clearedTimerIds: number[] = [];
    const setTimeoutStub = ((callback: () => void) => {
        const timerId = nextTimerId;
        nextTimerId += 1;
        callbacks.set(timerId, callback);
        pendingTimerIds.add(timerId);
        // The browser host returns a numeric timer while Node's lib types use Timeout.
        // eslint-disable-next-line no-restricted-syntax
        return timerId as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const clearTimeoutStub = ((timer: ReturnType<typeof setTimeout>) => {
        const timerId = Number(timer);
        clearedTimerIds.push(timerId);
        pendingTimerIds.delete(timerId);
    }) as typeof clearTimeout;

    vi.stubGlobal('setTimeout', setTimeoutStub);
    vi.stubGlobal('clearTimeout', clearTimeoutStub);

    return {
        clearedTimerIds,
        get latestTimerId() {
            return nextTimerId - 1;
        },
        get pendingTimerIds() {
            return [...pendingTimerIds];
        },
        run(timerId: number) {
            pendingTimerIds.delete(timerId);
            const callback = callbacks.get(timerId);
            if (!callback) {
                throw new Error(`Unknown numeric timer: ${timerId}`);
            }
            callback();
        },
    };
}

describe('BrowserDurableDjvuJobs', () => {
    const jobs = new BrowserDurableDjvuJobs(100, 2);
    const failure: FailureReceipt = {
        eventId: '0123456789abcdef0123456789abcdef' as FailureReceipt['eventId'],
        code: 'UNCLASSIFIED_RENDERER_ERROR',
        occurredAt: requireEpochMs(1),
        severity: 'error',
    };

    afterEach(() => {
        jobs.clearForTests();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('normalizes unexpected rejections into retained failed results', async () => {
        jobs.startOpen(requireJobId('open-failed'), requireRequestId('request-1'), () => Promise.reject(new Error('decoder crashed')));

        await expect(jobs.awaitOpen(requireJobId('open-failed'))).resolves.toEqual({
            success: false,
            jobId: requireJobId('open-failed'),
            error: 'decoder crashed',
        });
        expect(jobs.getState(requireJobId('open-failed'))).toMatchObject({
            status: 'failed',
            error: 'decoder crashed',
        });
    });

    it('expires terminal jobs after the retention TTL', async () => {
        vi.useFakeTimers();
        jobs.startConvert(requireJobId('convert-expired'), requireRequestId('request-1'), async () => ({success: true}));
        await jobs.awaitConvert(requireJobId('convert-expired'));

        await vi.advanceTimersByTimeAsync(100);

        expect(jobs.getState(requireJobId('convert-expired'))).toBeNull();
        expect(() => jobs.awaitConvert(requireJobId('convert-expired'))).toThrow('Unknown browser DjVu conversion job');
    });

    it('retains conversion failure identity in the terminal result and state', async () => {
        jobs.startConvert(requireJobId('convert-failed'), requireRequestId('request-1'), async () => ({
            success: false,
            error: 'browser conversion failed',
            failure,
        }));

        await expect(jobs.awaitConvert(requireJobId('convert-failed'))).resolves.toEqual({
            success: false,
            jobId: requireJobId('convert-failed'),
            error: 'browser conversion failed',
            failure,
        });
        expect(jobs.getState(requireJobId('convert-failed'))).toMatchObject({
            status: 'failed',
            error: 'browser conversion failed',
            failure,
        });
    });

    it('retains cancellation as an expected terminal outcome without a receipt', async () => {
        jobs.startConvert(requireJobId('convert-canceled'), requireRequestId('request-1'), async () => ({
            success: false,
            error: 'DjVu conversion canceled',
            expected: {
                kind: 'expected',
                code: 'canceled',
            },
        }));

        await expect(jobs.awaitConvert(requireJobId('convert-canceled'))).resolves.toEqual({
            success: false,
            jobId: requireJobId('convert-canceled'),
            error: 'DjVu conversion canceled',
            expected: {
                kind: 'expected',
                code: 'canceled',
            },
        });
        expect(jobs.getState(requireJobId('convert-canceled'))).toMatchObject({
            status: 'canceled',
            expected: {
                kind: 'expected',
                code: 'canceled',
            },
        });
        expect(jobs.getState(requireJobId('convert-canceled'))).not.toHaveProperty('failure');
    });

    it('starts conversion before returning so an immediate cancellation reaches the runner', async () => {
        let started = false;
        const jobId = requireJobId('convert-immediate-cancel');
        const run = vi.fn(async () => {
            started = true;
            return {
                success: false as const,
                error: 'canceled',
            };
        });

        jobs.startConvert(jobId, requireRequestId('request-immediate-cancel'), run);

        expect(started).toBe(true);
        expect(run).toHaveBeenCalledOnce();
    });

    it('finalizes success, error, and canceled results with browser numeric timers', async () => {
        const timers = installNumericTimerHarness();
        const outcomes = [
            {
                jobId: requireJobId('numeric-success'),
                requestId: requireRequestId('numeric-success'),
                result: {success: true},
                state: {
                    status: 'completed',
                    percent: 100,
                },
            },
            {
                jobId: requireJobId('numeric-error'),
                requestId: requireRequestId('numeric-error'),
                result: {
                    success: false,
                    error: 'numeric browser conversion failed',
                    failure,
                },
                state: {
                    status: 'failed',
                    percent: 0,
                    error: 'numeric browser conversion failed',
                    failure,
                },
            },
            {
                jobId: requireJobId('numeric-canceled'),
                requestId: requireRequestId('numeric-canceled'),
                result: {
                    success: false,
                    error: 'numeric browser conversion canceled',
                    expected: {
                        kind: 'expected',
                        code: 'canceled',
                    },
                },
                state: {
                    status: 'canceled',
                    percent: 0,
                    expected: {
                        kind: 'expected',
                        code: 'canceled',
                    },
                },
            },
        ] as const;

        for (const outcome of outcomes) {
            jobs.startConvert(outcome.jobId, outcome.requestId, async () => outcome.result);

            await expect(jobs.awaitConvert(outcome.jobId)).resolves.toEqual({
                ...outcome.result,
                jobId: outcome.jobId,
            });
            expect(jobs.getState(outcome.jobId)).toMatchObject({
                jobId: outcome.jobId,
                operation: 'djvu-convert',
                status: outcome.state.status,
                progress: {
                    jobId: outcome.jobId,
                    phase: 'converting',
                    percent: outcome.state.percent,
                },
                ...('error' in outcome.state ? {error: outcome.state.error} : {}),
                ...('failure' in outcome.state ? {failure: outcome.state.failure} : {}),
                ...('expected' in outcome.state ? {expected: outcome.state.expected} : {}),
            });

            const timerId = timers.latestTimerId;
            expect(typeof timerId).toBe('number');
            expect(timers.pendingTimerIds).toContain(timerId);
            timers.run(timerId);
            expect(jobs.getState(outcome.jobId)).toBeNull();
            expect(() => jobs.awaitConvert(outcome.jobId)).toThrow('Unknown browser DjVu conversion job');

            timers.run(timerId);
            expect(timers.clearedTimerIds.filter(id => id === timerId)).toHaveLength(1);
        }
    });

    it('finalizes browser numeric timers for an open result without changing its outcome', async () => {
        const timers = installNumericTimerHarness();
        const jobId = requireJobId('numeric-open');
        jobs.startOpen(jobId, requireRequestId('numeric-open'), async () => ({
            success: false,
            error: 'numeric browser open failed',
        }));

        await expect(jobs.awaitOpen(jobId)).resolves.toEqual({
            success: false,
            error: 'numeric browser open failed',
            jobId,
        });
        expect(jobs.getState(jobId)).toMatchObject({
            status: 'failed',
            error: 'numeric browser open failed',
        });
        const timerId = timers.latestTimerId;
        expect(typeof timerId).toBe('number');
        timers.run(timerId);
        expect(jobs.getState(jobId)).toBeNull();
        expect(() => jobs.awaitOpen(jobId)).toThrow('Unknown browser DjVu open job');
    });

    it('ignores a stale numeric timer after a terminal job ID is reused', async () => {
        const timers = installNumericTimerHarness();
        const reusedJobId = requireJobId('numeric-reused');

        jobs.startConvert(reusedJobId, requireRequestId('numeric-reused-old'), async () => ({success: true}));
        await expect(jobs.awaitConvert(reusedJobId)).resolves.toEqual({
            success: true,
            jobId: reusedJobId,
        });
        const staleTimerId = timers.latestTimerId;

        for (const jobId of [
            requireJobId('numeric-evict-1'),
            requireJobId('numeric-evict-2'),
        ]) {
            jobs.startConvert(jobId, requireRequestId(jobId), async () => ({success: true}));
            await jobs.awaitConvert(jobId);
        }

        expect(jobs.getState(reusedJobId)).toBeNull();
        jobs.startConvert(reusedJobId, requireRequestId('numeric-reused-new'), async () => ({
            success: false,
            error: 'new numeric result',
        }));
        await expect(jobs.awaitConvert(reusedJobId)).resolves.toEqual({
            success: false,
            error: 'new numeric result',
            jobId: reusedJobId,
        });
        const currentTimerId = timers.latestTimerId;
        expect(currentTimerId).not.toBe(staleTimerId);

        timers.run(staleTimerId);
        expect(jobs.getState(reusedJobId)).toMatchObject({
            status: 'failed',
            error: 'new numeric result',
        });
        await expect(jobs.awaitConvert(reusedJobId)).resolves.toEqual({
            success: false,
            error: 'new numeric result',
            jobId: reusedJobId,
        });

        timers.run(currentTimerId);
        expect(jobs.getState(reusedJobId)).toBeNull();
        expect(timers.clearedTimerIds.filter(id => id === staleTimerId)).toHaveLength(1);
        expect(timers.clearedTimerIds.filter(id => id === currentTimerId)).toHaveLength(1);
    });

    it('bounds retained terminal jobs without evicting active work', async () => {
        let resolveActive!: (result: {
            success: true;
            pageCount: number
        }) => void;
        jobs.startOpen(requireJobId('active'), requireRequestId('request-active'), () => new Promise((resolve) => {
            resolveActive = resolve;
        }));
        for (const jobId of [
            requireJobId('finished-1'),
            requireJobId('finished-2'),
            requireJobId('finished-3'),
        ]) {
            jobs.startOpen(jobId, requireRequestId(`request-${jobId}`), async () => ({
                success: true,
                pageCount: 1,
            }));
            await jobs.awaitOpen(jobId);
        }

        expect(jobs.getState(requireJobId('finished-1'))).toBeNull();
        expect(jobs.getState(requireJobId('active'))).toMatchObject({status: 'running'});
        resolveActive({
            success: true,
            pageCount: 2,
        });
        await expect(jobs.awaitOpen(requireJobId('active'))).resolves.toMatchObject({success: true});
    });
});
