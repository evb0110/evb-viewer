import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {delay} from 'es-toolkit/promise';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    ElectronE2ETeardownError,
    ElectronE2ETimeoutError,
    runElectronE2ETeardown,
    runWithElectronE2EDeadline,
} from '@tests/e2e/electron/helpers/electronE2ESessionFailure';

const SESSION_HELPER_SOURCE = readFileSync(
    join(process.cwd(), 'tests', 'e2e', 'electron', 'helpers', 'startElectronE2ESession.ts'),
    'utf8',
);

describe('Electron E2E deadline policy', () => {
    it('aborts a timed-out task, awaits its cleanup, and reports both failures', async () => {
        let observedAbort = false;
        let cleanupFinished = false;

        const failure = await runWithElectronE2EDeadline(
            'Waiting for session health',
            50,
            signal => new Promise<never>((_, reject) => {
                signal.addEventListener('abort', () => {
                    observedAbort = true;
                    reject(signal.reason);
                }, {once: true});
            }),
            {
                onTimeout: async () => {
                    await delay(20);
                    cleanupFinished = true;
                    throw new Error('stop refused');
                },
                diagnostics: () => 'session log tail',
            },
        ).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ElectronE2ETimeoutError);
        expect(observedAbort).toBe(true);
        expect(cleanupFinished).toBe(true);
        const message = (failure as Error).message;
        expect(message).toContain('Waiting for session health timed out after');
        expect(message).toContain('stop refused');
        expect(message).toContain('session log tail');
    });

    it('returns the task result and leaves the signal untouched when the task finishes in time', async () => {
        let aborted = false;

        const result = await runWithElectronE2EDeadline('Quick task', 1_000, async (signal) => {
            signal.addEventListener('abort', () => {
                aborted = true;
            }, {once: true});
            return 'done';
        });

        expect(result).toBe('done');
        expect(aborted).toBe(false);
    });

    it('never discards a session stop failure or races a task it cannot cancel', () => {
        expect(SESSION_HELPER_SOURCE).not.toMatch(/stopSingleSession\([^)]*\)\s*\.catch\(/u);
        expect(SESSION_HELPER_SOURCE).not.toContain('Promise.race(');
    });
});

describe('Electron E2E teardown aggregation', () => {
    it('runs every teardown step and aggregates their failures with the primary error', async () => {
        const primary = new Error('assertion failed');
        const order: string[] = [];

        const failure = await runElectronE2ETeardown(primary, [
            {
                label: 'heartbeat',
                run: async () => {
                    order.push('heartbeat');
                    throw new Error('renderer gone');
                },
            },
            {
                label: 'rss sampler',
                run: async () => {
                    order.push('rss');
                },
            },
            {
                label: 'session B stop',
                run: async () => {
                    order.push('stop B');
                    throw new Error('stop refused');
                },
            },
        ]).catch((error: unknown) => error);

        expect(order).toEqual([
            'heartbeat',
            'rss',
            'stop B',
        ]);
        expect(failure).toBeInstanceOf(ElectronE2ETeardownError);
        expect((failure as AggregateError).errors).toEqual([
            primary,
            expect.any(Error),
            expect.any(Error),
        ]);
        const message = (failure as Error).message;
        expect(message).toContain('assertion failed');
        expect(message).toContain('heartbeat: renderer gone');
        expect(message).toContain('session B stop: stop refused');
    });

    it('rethrows the primary error untouched when every teardown step succeeds', async () => {
        const primary = new Error('assertion failed');

        const failure = await runElectronE2ETeardown(primary, [{
            label: 'session stop',
            run: async () => undefined,
        }]).catch((error: unknown) => error);

        expect(failure).toBe(primary);
    });

    it('fails a passing test when its teardown fails', async () => {
        const stopFailure = new Error('stop left an Electron process alive');

        const failure = await runElectronE2ETeardown(null, [{
            label: 'session stop',
            run: async () => {
                throw stopFailure;
            },
        }]).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ElectronE2ETeardownError);
        expect((failure as AggregateError).errors).toEqual([stopFailure]);
        expect((failure as Error).message).toContain('session stop: stop left an Electron process alive');
    });

    it('resolves when nothing failed', async () => {
        await expect(runElectronE2ETeardown(null, [{
            label: 'session stop',
            run: async () => undefined,
        }])).resolves.toBeUndefined();
    });
});
