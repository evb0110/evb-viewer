import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createMainFailureReporter,
    MAIN_DIAGNOSTICS_MAX_SUPPRESSED_COUNT,
} from '@electron/features/diagnostics/public';
import {parseDiagnosticEventId} from '@contracts/diagnostics/diagnosticEventId';
import {requireEpochMs} from '@contracts/timestamps';
import type {DiagnosticRecord} from '@contracts/diagnostics/diagnosticRecord';

const BASE_STACK = 'Error\n    at mainFailure (electron/main.ts:12:4)';

function createInput(message = 'local details contain secret-document.pdf') {
    return {
        code: 'UNCLASSIFIED_MAIN_ERROR' as const,
        context: {},
        local: {
            source: 'main-test',
            message,
            cause: BASE_STACK,
            data: {path: '/Users/example/Documents/secret-document.pdf'},
        },
    };
}

function createIdFactory() {
    let nextId = 0;
    return () => {
        nextId += 1;
        return parseDiagnosticEventId(nextId.toString(16).padStart(32, '0'))!;
    };
}

describe('Electron main failure reporter', () => {
    it('initializes after the user-data path and before normal bootstrap', () => {
        const source = readFileSync(resolve(process.cwd(), 'electron/bootstrap/mainProcess.ts'), 'utf8');
        const indexOfMarker = (marker: string) => {
            const index = source.indexOf(marker);
            expect(index, marker).toBeGreaterThanOrEqual(0);
            return index;
        };
        const userDataIndex = indexOfMarker('app.setPath(\'userData\'');
        const resetIndex = indexOfMarker('resetSettingsCacheAfterUserDataPathChange();');
        const reporterIndex = indexOfMarker('initializeMainFailureReporter(');
        const bootstrapIndex = indexOfMarker('void runInitSequence({');

        expect(reporterIndex).toBeGreaterThan(userDataIndex);
        expect(reporterIndex).toBeGreaterThan(resetIndex);
        expect(reporterIndex).toBeLessThan(bootstrapIndex);
    });

    it('builds one closed record and returns its receipt without local details', () => {
        const send = vi.fn();
        const reporter = createMainFailureReporter({
            createEventId: createIdFactory(),
            preference: 'granted',
            transport: {
                isReady: true,
                send,
            },
        });

        const receipt = reporter.capture(createInput());
        const record = send.mock.calls[0]?.[0] as DiagnosticRecord;

        expect(receipt).toMatchObject({
            code: 'UNCLASSIFIED_MAIN_ERROR',
            severity: 'error',
        });
        expect(send).toHaveBeenCalledTimes(1);
        expect(record).toEqual({
            schemaVersion: 1,
            eventId: receipt.eventId,
            code: 'UNCLASSIFIED_MAIN_ERROR',
            severity: 'error',
            runtime: 'electron-main',
            operation: 'main-error',
            occurredAt: expect.any(Number),
            frames: [],
            context: {},
        });
        expect(JSON.stringify(record)).not.toContain('secret-document.pdf');
        expect('local' in record).toBe(false);
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 1,
            accepted: 1,
        });
    });

    it('installs a late adapter only while granted and invokes the grant loader once per transition', () => {
        const onPreferenceGranted = vi.fn();
        const send = vi.fn();
        const reporter = createMainFailureReporter({
            createEventId: createIdFactory(),
            preference: 'unknown',
            transport: {
                isReady: false,
                send: () => false,
            },
            onPreferenceGranted,
        });

        reporter.setPreference('granted');
        expect(onPreferenceGranted).toHaveBeenCalledOnce();
        expect(reporter.isTransportReady()).toBe(false);

        reporter.setTransport({
            isReady: true,
            send,
        });
        reporter.capture(createInput());
        expect(send).toHaveBeenCalledOnce();

        reporter.setPreference('denied');
        reporter.capture(createInput());
        expect(send).toHaveBeenCalledOnce();

        reporter.setPreference('granted');
        expect(onPreferenceGranted).toHaveBeenCalledTimes(2);
        reporter.capture(createInput());
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('exposes the in-flight adapter load so a persisted grant can wait before resending', async () => {
        let finishLoading!: () => void;
        const reporter = createMainFailureReporter({
            preference: 'unknown',
            transport: {isReady: false},
            onPreferenceGranted: () => new Promise<void>((resolve) => {
                finishLoading = resolve;
            }),
        });

        reporter.setPreference('granted');
        let ready = false;
        const readiness = reporter.waitForTransportReady().then(() => {
            ready = true;
        });
        await Promise.resolve();
        expect(ready).toBe(false);

        finishLoading();
        await readiness;
        expect(ready).toBe(true);
    });

    it('uses the source stack only for source-policy diagnostic codes', () => {
        const send = vi.fn();
        const reporter = createMainFailureReporter({
            preference: 'granted',
            transport: {send},
        });

        reporter.capture({
            code: 'MAIN_STARTUP_CRASH',
            context: {},
            local: {
                source: 'main-test',
                message: 'startup failed',
                cause: BASE_STACK,
            },
        });

        expect(send.mock.calls[0]?.[0]).toMatchObject({
            code: 'MAIN_STARTUP_CRASH',
            severity: 'fatal',
            operation: 'startup-crash',
            frames: [{
                module: 'electron/main.ts',
                function: 'mainFailure',
                line: 12,
                column: 4,
            }],
        });
    });

    it('never throws when event ID creation or transport readiness fails', () => {
        const reporter = createMainFailureReporter({
            createEventId: () => {
                throw new Error('random source unavailable');
            },
            preference: 'granted',
            transport: {isReady: () => {
                throw new Error('transport unavailable');
            }},
        });

        expect(() => reporter.capture(createInput())).not.toThrow();
        const receipt = reporter.capture(createInput('second failure'));

        expect(receipt.eventId).toMatch(/^[0-9a-f]{32}$/u);
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 2,
            transportFailed: 2,
            lastDropReason: 'transport-failed',
        });
    });

    it.each([
        () => false,
        () => Promise.reject(new Error('transport rejected')),
    ])('reserves an event ID after a failed transport send', async (sendResult) => {
        const send = vi.fn(sendResult);
        const reporter = createMainFailureReporter({
            createEventId: () => parseDiagnosticEventId('a'.repeat(32))!,
            preference: 'granted',
            transport: {send},
        });

        reporter.capture(createInput());
        reporter.capture(createInput('same receipt'));

        expect(send).toHaveBeenCalledOnce();
        await vi.waitFor(() => {
            expect(reporter.getHealthSnapshot()).toMatchObject({
                accepted: 0,
                duplicate: 1,
                transportFailed: 1,
            });
        });
    });

    it('checks policy before recent-ID dedupe so a later grant can retry the same record', () => {
        const send = vi.fn();
        const reporter = createMainFailureReporter({
            preference: 'unknown',
            transport: {send},
        });
        const firstReporter = createMainFailureReporter({
            createEventId: createIdFactory(),
            preference: 'granted',
            transport: {send},
        });
        const record = firstReporter.capture(createInput());
        const sentRecord = send.mock.calls[0]?.[0] as DiagnosticRecord;
        send.mockClear();

        reporter.captureRecord(sentRecord);
        expect(reporter.getGeneration()).toBe(0);
        reporter.setPreference('granted');
        reporter.captureRecord(sentRecord);
        reporter.captureRecord(sentRecord);

        expect(send).toHaveBeenCalledTimes(1);
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 3,
            accepted: 1,
            duplicate: 1,
            policyDropped: 1,
        });
        expect(reporter.captureRecord(sentRecord)).toEqual(record);
    });

    it('swaps to a drop transport before revocation and keeps unknown closed', () => {
        const send = vi.fn();
        const reporter = createMainFailureReporter({
            preference: 'unknown',
            transport: {send},
        });

        reporter.capture(createInput());
        expect(send).not.toHaveBeenCalled();
        expect(reporter.getGeneration()).toBe(0);

        reporter.setPreference('granted');
        reporter.capture(createInput('granted failure'));
        expect(send).toHaveBeenCalledOnce();

        reporter.setPreference('denied');
        expect(reporter.getGeneration()).toBe(1);
        reporter.capture(createInput('revoked failure'));
        expect(send).toHaveBeenCalledOnce();
    });

    it('does not apply an async transport result after revocation', async () => {
        let resolveSend!: (value: unknown) => void;
        const send = vi.fn(() => new Promise(resolve => {
            resolveSend = resolve;
        }));
        const reporter = createMainFailureReporter({
            preference: 'granted',
            transport: {send},
        });

        reporter.capture(createInput());
        expect(send).toHaveBeenCalledOnce();
        reporter.setPreference('denied');
        resolveSend(undefined);
        await Promise.resolve();
        await Promise.resolve();

        expect(reporter.getHealthSnapshot()).toMatchObject({
            accepted: 0,
            transportFailed: 0,
        });
    });

    it('suppresses a per-code and top-frame burst and emits one capped summary', () => {
        let now = 0;
        const send = vi.fn();
        const reporter = createMainFailureReporter({
            burstLimit: 1,
            burstWindowMs: 10,
            createEventId: createIdFactory(),
            now: () => now,
            preference: 'granted',
            transport: {send},
        });

        reporter.capture(createInput());
        for (let index = 0; index < MAIN_DIAGNOSTICS_MAX_SUPPRESSED_COUNT + 1; index += 1) {
            reporter.capture(createInput(`failure ${index}`));
        }
        now = 11;
        reporter.capture(createInput('summary boundary'));

        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[1]?.[1]).toBe(MAIN_DIAGNOSTICS_MAX_SUPPRESSED_COUNT);
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: MAIN_DIAGNOSTICS_MAX_SUPPRESSED_COUNT + 3,
            accepted: 2,
            burstSuppressed: MAIN_DIAGNOSTICS_MAX_SUPPRESSED_COUNT + 1,
        });
    }, 15_000);

    it('keeps an inherited renderer summary when main burst aggregation suppresses it', () => {
        let now = 0;
        const send = vi.fn();
        const reporter = createMainFailureReporter({
            burstLimit: 1,
            burstWindowMs: 10,
            now: () => now,
            preference: 'granted',
            transport: {send},
        });
        const rendererRecord = (eventId: string): DiagnosticRecord => ({
            schemaVersion: 1,
            eventId: eventId as DiagnosticRecord['eventId'],
            code: 'UNCLASSIFIED_RENDERER_ERROR',
            severity: 'error',
            runtime: 'electron-renderer',
            operation: 'renderer-error',
            occurredAt: requireEpochMs(1),
            frames: [{module: 'app/utils/failureReporter.ts'}],
            context: {},
        });

        reporter.captureRecord(rendererRecord('a'.repeat(32)), 3);
        reporter.captureRecord(rendererRecord('b'.repeat(32)), 4);
        now = 10;
        reporter.captureRecord(rendererRecord('c'.repeat(32)), 6);

        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[0]?.[1]).toBe(3);
        expect(send.mock.calls[1]?.[1]).toBe(11);
        expect(reporter.getHealthSnapshot()).toMatchObject({
            accepted: 2,
            burstSuppressed: 5,
        });
    });

    it('keeps different top frames in separate burst buckets', () => {
        const send = vi.fn();
        const reporter = createMainFailureReporter({
            burstLimit: 1,
            createEventId: createIdFactory(),
            preference: 'granted',
            transport: {send},
        });

        reporter.capture({
            code: 'MAIN_STARTUP_CRASH',
            context: {},
            local: {
                source: 'main-test',
                message: 'first frame',
                cause: BASE_STACK,
            },
        });
        reporter.capture({
            code: 'MAIN_STARTUP_CRASH',
            context: {},
            local: {
                source: 'main-test',
                message: 'different frame',
                cause: 'Error\n    at otherFailure (electron/window.ts:20:2)',
            },
        });

        expect(send).toHaveBeenCalledTimes(2);
        expect(reporter.getHealthSnapshot().burstSuppressed).toBe(0);
    });
});
