import type * as TViMockOriginalModule from '@electron/features/diagnostics/public';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    appended: [] as string[],
    reporter: {capture: vi.fn()},
}));

vi.mock('electron', () => ({BrowserWindow: {getAllWindows: () => []}}));
vi.mock('worker_threads', () => ({isMainThread: false}));
vi.mock('@electron/features/diagnostics/public', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getMainFailureReporter: () => mocks.reporter,
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

describe('child logger diagnostic ownership', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        mocks.appended = [];
        mocks.reporter.capture.mockReset();
        process.env.ELECTRON_FILE_LOG_LEVEL = 'DEBUG';
    });

    afterEach(() => {
        vi.useRealTimers();
        delete process.env.ELECTRON_FILE_LOG_LEVEL;
    });

    it('keeps worker-thread errors local and returns no remotely forwardable receipt', async () => {
        const {
            createLogger,
            flushPendingLogWrites,
        } = await import('@electron/utils/createLogger');
        const logger = createLogger('worker-local-only-test', {broadcastToRenderers: false});

        expect(logger.error('worker failure', {
            code: 'MAIN_WORKER_TASK_FAILED',
            context: {},
        })).toBeUndefined();
        expect(logger.error('worker typed failure', {
            code: 'MAIN_CODEX_MCP_INTEGRATION_FAILED',
            context: {action: 'enable'},
            cause: new Error('worker cause'),
        })).toBeUndefined();
        expect(mocks.reporter.capture).not.toHaveBeenCalled();
        await flushPendingLogWrites();
        expect(mocks.appended.join('')).toContain('worker failure');
        expect(mocks.appended.join('')).toContain('worker typed failure');
    });
});
