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
    broadcasts: [] as unknown[][],
    readdir: vi.fn(async () => [] as string[]),
}));

vi.mock('electron', () => ({BrowserWindow: {getAllWindows: () => [{
    isDestroyed: () => false,
    webContents: {send: (...args: unknown[]) => mocks.broadcasts.push(args)},
}]}}));
vi.mock('worker_threads', () => ({isMainThread: true}));

vi.mock('fs', () => ({
    mkdirSync: vi.fn(),
    statSync: vi.fn(() => ({
        size: 0,
        isFile: () => true,
        mtimeMs: 0,
    })),
}));
vi.mock('fs/promises', () => ({
    appendFile: vi.fn(async (_path: string, payload: string) => {
        if (payload.length > 0) {
            mocks.appended.push(payload);
        }
    }),
    readdir: mocks.readdir,
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
}));

function countWrittenLines() {
    return mocks.appended
        .join('')
        .split('\n')
        .filter(line => line.length > 0)
        .length;
}

describe('file logger write buffering', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        mocks.appended = [];
        mocks.broadcasts = [];
        mocks.readdir.mockReset();
        mocks.readdir.mockResolvedValue([]);
        process.env.ELECTRON_FILE_LOG_LEVEL = 'DEBUG';
        process.env.ELECTRON_RENDER_LOG_LEVEL = 'INFO';
    });

    afterEach(() => {
        vi.useRealTimers();
        delete process.env.ELECTRON_FILE_LOG_LEVEL;
        delete process.env.ELECTRON_RENDER_LOG_LEVEL;
    });

    it('coalesces a burst of lines into a single append', async () => {
        const { createLogger } = await import('@electron/utils/createLogger');
        const logger = createLogger('buffer-test', {broadcastToRenderers: false});

        for (let index = 0; index < 25; index += 1) {
            logger.info(`line ${index}`);
        }
        expect(mocks.appended).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(150);
        expect(mocks.appended).toHaveLength(1);
        expect(countWrittenLines()).toBe(25);
    });

    it('writes error lines without waiting for the flush window', async () => {
        const { createLogger } = await import('@electron/utils/createLogger');
        const logger = createLogger('buffer-error-test', {broadcastToRenderers: false});

        logger.info('buffered');
        logger.error('urgent', {
            code: 'MAIN_WINDOW_OPERATION_FAILED',
            context: {},
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(countWrittenLines()).toBe(2);
    });

    it('flushes buffered lines on shutdown', async () => {
        const {
            createLogger,
            flushPendingLogWrites,
        } = await import('@electron/utils/createLogger');
        const logger = createLogger('buffer-flush-test', {broadcastToRenderers: false});

        logger.info('pending on quit');
        expect(mocks.appended).toHaveLength(0);

        await flushPendingLogWrites();
        expect(countWrittenLines()).toBe(1);
        expect(mocks.appended.join('')).toContain('pending on quit');
    });

    it('does not make the next write wait for directory pruning', async () => {
        const {
            createLogger,
            flushPendingLogWrites,
        } = await import('@electron/utils/createLogger');
        await vi.dynamicImportSettled();
        vi.setSystemTime(new Date(Date.now() + 60_001));
        mocks.readdir.mockClear();
        let releasePrune: (() => void) | undefined;
        mocks.readdir.mockImplementationOnce(() => new Promise<string[]>(resolve => {
            releasePrune = () => resolve([]);
        }));
        const logger = createLogger('prune-queue-test', {broadcastToRenderers: false});

        try {
            logger.error('first', {
                code: 'MAIN_WINDOW_OPERATION_FAILED',
                context: {},
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(mocks.readdir).toHaveBeenCalledOnce();
            expect(mocks.appended).toHaveLength(1);
            expect(mocks.appended[0]).toContain('first');
            expect(mocks.appended[0]).not.toContain('second');

            logger.error('second', {
                code: 'MAIN_WINDOW_OPERATION_FAILED',
                context: {},
            });
            await vi.advanceTimersByTimeAsync(0);

            expect(mocks.appended).toHaveLength(2);
            expect(mocks.appended.join('')).toContain('second');
        } finally {
            releasePrune?.();
            await flushPendingLogWrites();
        }
    });

    it('redacts once before file writes and renderer broadcasts', async () => {
        const {
            createLogger,
            flushPendingLogWrites,
        } = await import('@electron/utils/createLogger');
        const logger = createLogger('redaction-test');
        logger.info('GET https://user:pass@updates.example.test:8443/latest?channel=stable&token=secret#private');

        await flushPendingLogWrites();
        await vi.dynamicImportSettled();

        const expectedUrl = 'https://[redacted]@updates.example.test:8443/latest?channel=[redacted]&token=[redacted]#[redacted]';
        expect(mocks.appended.join('')).toContain(expectedUrl);
        expect(mocks.broadcasts.at(-1)?.[0]).toBe('debug:log');
        expect(mocks.broadcasts.at(-1)?.[1]).toMatchObject({message: `[INFO] GET ${expectedUrl}`});
        expect(JSON.stringify(mocks.broadcasts)).not.toContain('user:pass');
        expect(mocks.appended.join('')).not.toContain('token=secret');
    });

    it('redacts composite JSON credentials without deleting sibling log fields', async () => {
        const {
            createLogger,
            flushPendingLogWrites,
        } = await import('@electron/utils/createLogger');
        const logger = createLogger('composite-redaction-test', {broadcastToRenderers: false});
        logger.warn('event={"authorization":{"scheme":"Basic","credentials":"abc def"},"next":"useful"}');

        await flushPendingLogWrites();

        expect(mocks.appended.join('')).toContain(
            'event={"authorization":"[redacted-secret]","next":"useful"}',
        );
        expect(mocks.appended.join('')).not.toContain('abc def');
    });
});
