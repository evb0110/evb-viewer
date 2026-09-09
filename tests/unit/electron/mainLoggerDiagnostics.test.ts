import type * as TViMockOriginalModule from '@electron/features/diagnostics/public';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {parseDiagnosticEventId} from '@contracts/diagnostics/diagnosticEventId';
import {requireEpochMs} from '@contracts/timestamps';

const mocks = vi.hoisted(() => ({
    appended: [] as string[],
    broadcasts: [] as unknown[][],
    reporter: {capture: vi.fn()},
    activeReporter: true,
    windows: [] as Array<{
        isDestroyed: () => boolean;
        webContents: {send: (...args: unknown[]) => void};
    }>,
}));

vi.mock('electron', () => ({BrowserWindow: {getAllWindows: () => mocks.windows}}));
vi.mock('worker_threads', () => ({isMainThread: true}));
vi.mock('@electron/features/diagnostics/public', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getMainFailureReporter: () => mocks.activeReporter ? mocks.reporter : null,
}));
vi.mock('fs', () => ({
    mkdirSync: vi.fn(),
    statSync: vi.fn(() => ({size: 0})),
}));
vi.mock('fs/promises', () => ({
    appendFile: vi.fn(async (_path: string, payload: string) => {
        if (payload.length > 0) {
            mocks.appended.push(payload);
        }
    }),
    readdir: vi.fn(async () => []),
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
}));

const receipt = {
    eventId: parseDiagnosticEventId('a'.repeat(32))!,
    code: 'UNCLASSIFIED_MAIN_ERROR' as const,
    occurredAt: requireEpochMs(1_757_000_000_000),
    severity: 'error' as const,
};

describe('main logger diagnostic receipt ownership', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        mocks.appended = [];
        mocks.broadcasts = [];
        mocks.activeReporter = true;
        mocks.reporter.capture.mockReset().mockReturnValue(receipt);
        mocks.windows = [{
            isDestroyed: () => false,
            webContents: {send: (...args: unknown[]) => mocks.broadcasts.push(args)},
        }];
        process.env.ELECTRON_FILE_LOG_LEVEL = 'DEBUG';
        process.env.ELECTRON_RENDER_LOG_LEVEL = 'WARN';
    });

    afterEach(() => {
        vi.useRealTimers();
        delete process.env.ELECTRON_FILE_LOG_LEVEL;
        delete process.env.ELECTRON_RENDER_LOG_LEVEL;
    });

    it('uses a classified code and fresh call-site stack while preserving redacted local logging', async () => {
        const {
            createLogger,
            flushPendingLogWrites,
        } = await import('@electron/utils/createLogger');
        const logger = createLogger('main-receipt-test');
        const message = 'GET https://user:pass@updates.example.test/latest?token=secret';

        expect(logger.error(message, {
            code: 'MAIN_STARTUP_INITIALIZATION_FAILED',
            context: {},
        })).toEqual(receipt);
        expect(mocks.reporter.capture).toHaveBeenCalledWith(expect.objectContaining({
            code: 'MAIN_STARTUP_INITIALIZATION_FAILED',
            operation: 'main-error',
            context: {},
            local: expect.objectContaining({
                source: 'main-receipt-test',
                message,
                cause: expect.stringContaining('captureMainLoggerFailure'),
            }),
        }));

        await flushPendingLogWrites();
        await vi.dynamicImportSettled();

        const broadcast = mocks.broadcasts.at(-1)?.[1] as Record<string, unknown>;
        expect(broadcast.failureRef).toEqual({
            eventId: receipt.eventId,
            code: receipt.code,
            severity: receipt.severity,
        });
        expect(mocks.appended.join('')).toContain('https://[redacted]@updates.example.test/latest?token=[redacted]');
        expect(JSON.stringify(mocks.broadcasts)).not.toContain('user:pass');
        expect(JSON.stringify(mocks.broadcasts)).not.toContain('token=secret');
    });

    it('captures a caller-provided closed code and bounded context', async () => {
        const {createLogger} = await import('@electron/utils/createLogger');
        const logger = createLogger('main-typed-failure-test');
        const cause = new Error('Codex registration failed');

        expect(logger.error('typed failure', {
            code: 'MAIN_CODEX_MCP_INTEGRATION_FAILED',
            context: {action: 'enable'},
            cause,
        })).toEqual(receipt);
        expect(mocks.reporter.capture).toHaveBeenCalledWith({
            code: 'MAIN_CODEX_MCP_INTEGRATION_FAILED',
            context: {action: 'enable'},
            operation: 'main-error',
            local: {
                source: 'main-typed-failure-test',
                message: 'typed failure',
                cause,
            },
        });
    });

    it('reuses a receipt attached to a wrapped cause', async () => {
        const {createLogger} = await import('@electron/utils/createLogger');
        const logger = createLogger('main-wrapped-receipt-test');
        const cause = new Error('already reported');
        Object.defineProperty(cause, 'failure', {
            configurable: true,
            value: receipt,
        });

        expect(logger.error('wrapped failure', {
            code: 'MAIN_DOCUMENT_REVEAL_FAILED',
            context: {},
            cause,
        })).toEqual(receipt);
        expect(mocks.reporter.capture).not.toHaveBeenCalled();
    });

    it('reuses a provided receipt without creating a second occurrence', async () => {
        const {
            createLogger,
            flushPendingLogWrites,
        } = await import('@electron/utils/createLogger');
        const logger = createLogger('main-existing-receipt-test');

        expect(logger.error('already captured', receipt)).toEqual(receipt);
        expect(mocks.reporter.capture).not.toHaveBeenCalled();
        await flushPendingLogWrites();
        await vi.dynamicImportSettled();
        expect((mocks.broadcasts.at(-1)?.[1] as Record<string, unknown>).failureRef).toEqual({
            eventId: receipt.eventId,
            code: receipt.code,
            severity: receipt.severity,
        });
    });

    it('projects one main-owned event to every live window with the same Error ID', async () => {
        mocks.windows.push({
            isDestroyed: () => false,
            webContents: {send: (...args: unknown[]) => mocks.broadcasts.push(args)},
        });
        const {
            createLogger,
            flushPendingLogWrites,
        } = await import('@electron/utils/createLogger');
        const logger = createLogger('main-multi-window-test');

        expect(logger.error('one main failure', {
            code: 'MAIN_WINDOW_OPERATION_FAILED',
            context: {},
        })).toEqual(receipt);
        expect(mocks.reporter.capture).toHaveBeenCalledOnce();
        await flushPendingLogWrites();
        await vi.dynamicImportSettled();

        expect(mocks.broadcasts).toHaveLength(2);
        const projections = mocks.broadcasts.map(([
            , data,
        ]) => data);
        expect(projections[0]).toBe(projections[1]);
        expect(projections).toEqual([
            expect.objectContaining({
                level: 'ERROR',
                failureRef: {
                    eventId: receipt.eventId,
                    code: receipt.code,
                    severity: receipt.severity,
                },
            }),
            expect.objectContaining({
                level: 'ERROR',
                failureRef: {
                    eventId: receipt.eventId,
                    code: receipt.code,
                    severity: receipt.severity,
                },
            }),
        ]);
    });

    it('keeps an unowned ERROR local when the logger has no active main reporter', async () => {
        mocks.activeReporter = false;
        const {
            createLogger,
            flushPendingLogWrites,
        } = await import('@electron/utils/createLogger');
        const logger = createLogger('main-local-only-test');

        expect(logger.error('local only', {
            code: 'MAIN_WINDOW_OPERATION_FAILED',
            context: {},
        })).toBeUndefined();
        logger.warn('warning only');
        await flushPendingLogWrites();
        await vi.dynamicImportSettled();

        expect(mocks.reporter.capture).not.toHaveBeenCalled();
        expect(mocks.broadcasts).toEqual([[
            expect.any(String),
            expect.objectContaining({level: 'WARN'}),
        ]]);
    });

    it('falls back to a closed reporter-owned occurrence when context is out of range', async () => {
        const {createLogger} = await import('@electron/utils/createLogger');
        const logger = createLogger('main-invalid-context-test');

        expect(logger.error('typed failure with invalid context', {
            code: 'MAIN_CODEX_MCP_INTEGRATION_FAILED',
            context: {action: 'outside-the-closed-set'} as never,
        })).toEqual(receipt);
        expect(mocks.reporter.capture).toHaveBeenCalledWith(expect.objectContaining({
            code: 'MAIN_CODEX_MCP_INTEGRATION_FAILED',
            context: {},
        }));
        await vi.dynamicImportSettled();
        expect((mocks.broadcasts.at(-1)?.[1] as Record<string, unknown>).failureRef).toEqual({
            eventId: receipt.eventId,
            code: receipt.code,
            severity: receipt.severity,
        });
    });
});
