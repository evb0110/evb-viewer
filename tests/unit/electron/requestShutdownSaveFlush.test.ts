import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import {
    requestShutdownSaveFlush,
    shutdownSaveFlushRequiresRecoveryPreservation,
} from '@electron/bootstrap/requestShutdownSaveFlush';
import {createRawIpcRegistrationAudit} from '@electron/platform-ipc/rawIpcRegistration';

const state = vi.hoisted(() => ({
    listener: null as null | ((event: {sender: {id: number}}, payload: unknown) => void),
    workingCopyMap: new Map<string, {
        backingState: 'lazy-original' | 'materialized';
        ownerWebContentsId?: number;
    }>(),
}));

vi.mock('electron', () => ({ipcMain: {
    on: vi.fn((_channel: string, listener: typeof state.listener) => {
        state.listener = listener;
    }),
    removeListener: vi.fn((_channel: string, listener: typeof state.listener) => {
        if (state.listener === listener) {
            state.listener = null;
        }
    }),
}}));

vi.mock('@electron/file-access/workingCopyStore', () => ({workingCopyMap: state.workingCopyMap}));

function createWindow(response: (requestId: string) => Record<string, unknown>) {
    return {
        id: 1,
        isDestroyed: () => false,
        webContents: {
            id: 7,
            isDestroyed: () => false,
            send: vi.fn((_channel: string, payload: {requestId: string}) => {
                state.listener?.(
                    {sender: {id: 7}},
                    {
                        callbackCount: 1,
                        requestId: payload.requestId,
                        ...response(payload.requestId),
                    },
                );
            }),
        },
    };
}

describe('requestShutdownSaveFlush', () => {
    beforeEach(() => {
        state.listener = null;
        state.workingCopyMap.clear();
    });

    it('preserves all owned working copies when the renderer flush reports a failure', async () => {
        const workingCopyPath = '/tmp/pdf-work-failed/working.pdf';
        state.workingCopyMap.set(workingCopyPath, {
            backingState: 'materialized',
            ownerWebContentsId: 7,
        });
        const logger = {
            debug: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
        };

        await expect(requestShutdownSaveFlush({
            getWindows: () => [createWindow(() => ({error: 'save failed'}))],
            logger,
            timeoutMs: 1_000,
        })).resolves.toEqual({
            dirtyWorkingCopyPaths: [workingCopyPath],
            failedWindowIds: [1],
            flushedWorkingCopyPaths: [],
            timedOutWindowIds: [],
        });
    });

    it('records and cleans up the real shutdown response listener', async () => {
        const audit = createRawIpcRegistrationAudit();
        const logger = {
            debug: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
        };

        await requestShutdownSaveFlush({
            getWindows: () => [createWindow(() => ({}))],
            logger,
            timeoutMs: 1_000,
            rawIpcRegistrationAudit: audit,
        });

        expect(audit.getRegisteredNames()).toEqual([]);
        expect(state.listener).toBeNull();
    });

    it('rejects a dirty lazy working copy reported as flushed', async () => {
        const workingCopyPath = '/tmp/pdf-work-lazy/working.pdf';
        state.workingCopyMap.set(workingCopyPath, {
            backingState: 'lazy-original',
            ownerWebContentsId: 7,
        });
        const logger = {
            debug: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
        };

        await expect(requestShutdownSaveFlush({
            getWindows: () => [createWindow(() => ({flushedWorkingCopyPaths: [workingCopyPath]}))],
            logger,
            timeoutMs: 1_000,
        })).resolves.toEqual({
            dirtyWorkingCopyPaths: [workingCopyPath],
            failedWindowIds: [],
            flushedWorkingCopyPaths: [],
            timedOutWindowIds: [],
        });
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('WORKING_COPY_SHUTDOWN_FLUSH_UNMATERIALIZED'),
            {
                code: 'MAIN_SHUTDOWN_SAVE_FLUSH_FAILED',
                context: {},
            },
        );
    });

    it('preserves exact dirty paths when renderer reports conflict with a flush', async () => {
        const workingCopyPath = ' /tmp/pdf-work-conflict/working.pdf ';
        state.workingCopyMap.set(workingCopyPath, {
            backingState: 'materialized',
            ownerWebContentsId: 7,
        });
        const logger = {
            debug: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
        };

        await expect(requestShutdownSaveFlush({
            getWindows: () => [createWindow(() => ({
                dirtyWorkingCopyPaths: [workingCopyPath],
                flushedWorkingCopyPaths: [workingCopyPath],
            }))],
            logger,
            timeoutMs: 1_000,
        })).resolves.toEqual({
            dirtyWorkingCopyPaths: [workingCopyPath],
            failedWindowIds: [],
            flushedWorkingCopyPaths: [],
            timedOutWindowIds: [],
        });
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('both dirty and flushed'),
            {
                code: 'MAIN_SHUTDOWN_SAVE_FLUSH_FAILED',
                context: {},
            },
        );
    });

    it.each([
        [
            'a malformed response',
            () => ({callbackCount: 'one'}),
        ],
        [
            'a renderer with no registered handler',
            () => ({callbackCount: 0}),
        ],
    ])('preserves owned working copies for %s', async (_label, response) => {
        const workingCopyPath = '/tmp/pdf-work-untrusted/working.pdf';
        state.workingCopyMap.set(workingCopyPath, {
            backingState: 'materialized',
            ownerWebContentsId: 7,
        });
        const logger = {
            debug: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
        };

        await expect(requestShutdownSaveFlush({
            getWindows: () => [createWindow(response)],
            logger,
            timeoutMs: 1_000,
        })).resolves.toEqual({
            dirtyWorkingCopyPaths: [workingCopyPath],
            failedWindowIds: [1],
            flushedWorkingCopyPaths: [],
            timedOutWindowIds: [],
        });
        expect(logger.error).toHaveBeenCalledOnce();
    });

    it.each([
        {
            dirtyWorkingCopyPaths: ['/tmp/dirty.pdf'],
            failedWindowIds: [],
            flushedWorkingCopyPaths: [],
            timedOutWindowIds: [],
        },
        {
            dirtyWorkingCopyPaths: [],
            failedWindowIds: [7],
            flushedWorkingCopyPaths: [],
            timedOutWindowIds: [],
        },
        {
            dirtyWorkingCopyPaths: [],
            failedWindowIds: [],
            flushedWorkingCopyPaths: [],
            timedOutWindowIds: [7],
        },
    ])('requires recovery preservation for incomplete renderer flush outcome %#', summary => {
        expect(shutdownSaveFlushRequiresRecoveryPreservation(summary)).toBe(true);
    });

    it('allows recovery cleanup only after a fully successful renderer flush', () => {
        expect(shutdownSaveFlushRequiresRecoveryPreservation({
            dirtyWorkingCopyPaths: [],
            failedWindowIds: [],
            flushedWorkingCopyPaths: ['/tmp/flushed.pdf'],
            timedOutWindowIds: [],
        })).toBe(false);
    });
});
