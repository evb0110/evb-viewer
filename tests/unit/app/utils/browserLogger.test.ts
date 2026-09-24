import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import type { FailureReceipt } from '@contracts/diagnostics/failureReceipt';
import {requireEpochMs} from '@contracts/timestamps';

const LOG_LEVEL_STORAGE_KEY = 'evb-viewer:log-level';
function createTestReceipt(
    eventId = '0123456789abcdef0123456789abcdef',
): FailureReceipt {
    return {
        eventId: eventId,
        code: 'UNCLASSIFIED_RENDERER_ERROR',
        occurredAt: requireEpochMs(1),
        severity: 'error',
    };
}

const EXISTING_RECEIPT = createTestReceipt();
interface IWindowStubOptions {
    logLevel?: string;
    diagnosticWarnAsWarn?: boolean;
    pdfNavLogConsole?: boolean;
}

function createWindowStub(options: IWindowStubOptions = {}) {
    const rendererLog = vi.fn();
    const windowStub: Record<string, unknown> = {
        localStorage: {getItem: vi.fn((key: string) => (
            key === LOG_LEVEL_STORAGE_KEY ? options.logLevel ?? null : null
        ))},
        electronAPI: createElectronPlatformApiFixture({settings: {rendererLog}}),
    };
    if (options.diagnosticWarnAsWarn !== undefined) {
        windowStub.__diagnosticWarnAsWarn = options.diagnosticWarnAsWarn;
    }
    if (options.pdfNavLogConsole !== undefined) {
        windowStub.__pdfNavLogConsole = options.pdfNavLogConsole;
    }
    return {
        windowStub,
        rendererLog,
    };
}

function spyOnConsole() {
    return {
        debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
        info: vi.spyOn(console, 'info').mockImplementation(() => {}),
        warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
        error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
}

async function importBrowserLogger() {
    const module = await import('@app/utils/browserLogger');
    return module.BrowserLogger;
}

describe('BrowserLogger', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.doUnmock('@app/utils/failureReporter');
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('suppresses debug and info at the default warn level', async () => {
        const {
            windowStub,
            rendererLog,
        } = createWindowStub();
        vi.stubGlobal('window', windowStub);
        const consoleSpies = spyOnConsole();
        const logger = await importBrowserLogger();

        logger.debug('section-a', 'debug message');
        logger.info('section-a', 'info message');

        expect(consoleSpies.debug).not.toHaveBeenCalled();
        expect(consoleSpies.info).not.toHaveBeenCalled();
        expect(rendererLog).not.toHaveBeenCalled();
    });

    it('emits and forwards warn and error at the default level', async () => {
        const {
            windowStub,
            rendererLog,
        } = createWindowStub();
        vi.stubGlobal('window', windowStub);
        const consoleSpies = spyOnConsole();
        const logger = await importBrowserLogger();

        logger.warn('section-a', 'warn message', {detail: 1});
        logger.error('section-a', 'error message', undefined, EXISTING_RECEIPT);

        expect(consoleSpies.warn).toHaveBeenCalledTimes(1);
        expect(consoleSpies.error).toHaveBeenCalledTimes(1);
        expect(rendererLog).toHaveBeenCalledTimes(2);
        expect(rendererLog).toHaveBeenNthCalledWith(1, expect.objectContaining({
            level: 'warn',
            section: 'section-a',
            message: 'warn message',
            data: {detail: 1},
        }));
        expect(rendererLog).toHaveBeenNthCalledWith(2, expect.objectContaining({
            level: 'error',
            section: 'section-a',
            message: 'error message',
        }));
    });

    it('keeps diagnostic silent at the default level', async () => {
        const {
            windowStub,
            rendererLog,
        } = createWindowStub();
        vi.stubGlobal('window', windowStub);
        const consoleSpies = spyOnConsole();
        const logger = await importBrowserLogger();

        logger.diagnostic('pdf-nav', 'trace message');
        logger.diagnosticThrottled('pdf-nav', 'key-1', 100, 'throttled trace');

        expect(consoleSpies.debug).not.toHaveBeenCalled();
        expect(consoleSpies.warn).not.toHaveBeenCalled();
        expect(rendererLog).not.toHaveBeenCalled();
    });

    it('emits diagnostic as debug when the configured level is debug', async () => {
        const {
            windowStub,
            rendererLog,
        } = createWindowStub({logLevel: 'debug'});
        vi.stubGlobal('window', windowStub);
        const consoleSpies = spyOnConsole();
        const logger = await importBrowserLogger();

        logger.diagnostic('section-a', 'trace message', {step: 1});

        expect(consoleSpies.debug).toHaveBeenCalledTimes(1);
        expect(consoleSpies.warn).not.toHaveBeenCalled();
        expect(rendererLog).toHaveBeenCalledWith(expect.objectContaining({
            level: 'debug',
            section: 'section-a',
            message: 'trace message',
            data: {step: 1},
        }));
    });

    it('forwards pdf navigation diagnostics without writing console noise by default', async () => {
        const {
            windowStub,
            rendererLog,
        } = createWindowStub({logLevel: 'debug'});
        vi.stubGlobal('window', windowStub);
        const consoleSpies = spyOnConsole();
        const logger = await importBrowserLogger();

        logger.diagnostic('pdf-nav', 'trace message', {step: 1});

        expect(consoleSpies.debug).not.toHaveBeenCalled();
        expect(rendererLog).toHaveBeenCalledWith(expect.objectContaining({
            level: 'debug',
            section: 'pdf-nav',
            message: 'trace message',
            data: {step: 1},
        }));
    });

    it('writes pdf navigation diagnostics to console when the console trace flag is set', async () => {
        const {
            windowStub,
            rendererLog,
        } = createWindowStub({
            logLevel: 'debug',
            pdfNavLogConsole: true,
        });
        vi.stubGlobal('window', windowStub);
        const consoleSpies = spyOnConsole();
        const logger = await importBrowserLogger();

        logger.diagnostic('pdf-nav', 'trace message', {step: 1});

        expect(consoleSpies.debug).toHaveBeenCalledTimes(1);
        expect(rendererLog).toHaveBeenCalledWith(expect.objectContaining({
            level: 'debug',
            section: 'pdf-nav',
        }));
    });

    it('promotes diagnostic to warn when __diagnosticWarnAsWarn is set', async () => {
        const {
            windowStub,
            rendererLog,
        } = createWindowStub({diagnosticWarnAsWarn: true});
        vi.stubGlobal('window', windowStub);
        const consoleSpies = spyOnConsole();
        const logger = await importBrowserLogger();

        logger.diagnostic('pdf-nav', 'trace message');

        expect(consoleSpies.warn).toHaveBeenCalledTimes(1);
        expect(consoleSpies.debug).not.toHaveBeenCalled();
        expect(rendererLog).toHaveBeenCalledWith(expect.objectContaining({
            level: 'warn',
            section: 'pdf-nav',
        }));
    });

    it('throttles diagnosticThrottled and reports the suppressed count', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const {
            windowStub,
            rendererLog,
        } = createWindowStub({logLevel: 'debug'});
        vi.stubGlobal('window', windowStub);
        const consoleSpies = spyOnConsole();
        const logger = await importBrowserLogger();

        logger.diagnosticThrottled('section-a', 'key-1', 1_000, 'tick', {sequence: 1});
        logger.diagnosticThrottled('section-a', 'key-1', 1_000, 'tick', {sequence: 2});
        logger.diagnosticThrottled('section-a', 'key-1', 1_000, 'tick', {sequence: 3});

        expect(consoleSpies.debug).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date('2026-01-01T00:00:01.500Z'));
        logger.diagnosticThrottled('section-a', 'key-1', 1_000, 'tick', {sequence: 4});

        expect(consoleSpies.debug).toHaveBeenCalledTimes(2);
        expect(rendererLog).toHaveBeenLastCalledWith(expect.objectContaining({data: expect.objectContaining({
            sequence: 4,
            throttledSuppressedCount: 2,
            throttledIntervalMs: 1_000,
            throttledKey: 'key-1',
        })}));
    });

    it('resolves lazy data only when the log is emitted', async () => {
        const { windowStub } = createWindowStub();
        vi.stubGlobal('window', windowStub);
        spyOnConsole();
        const logger = await importBrowserLogger();
        const lazyData = vi.fn(() => ({heavy: true}));

        logger.debug('section-a', 'filtered message', lazyData);
        expect(lazyData).not.toHaveBeenCalled();

        logger.diagnosticThrottled('section-a', 'key-1', 1_000, 'filtered throttled message', lazyData);
        expect(lazyData).not.toHaveBeenCalled();

        logger.warn('section-a', 'emitted message', lazyData);
        expect(lazyData).toHaveBeenCalledTimes(1);
    });

    it('serializes Error data for forwarding', async () => {
        const {
            windowStub,
            rendererLog,
        } = createWindowStub();
        vi.stubGlobal('window', windowStub);
        spyOnConsole();
        const logger = await importBrowserLogger();

        logger.warn('section-a', 'failed', new Error('boom'));

        expect(rendererLog).toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({
            name: 'Error',
            message: 'boom',
        })}));
    });

    it('preserves nested errors in JSON console captures as well as forwarded logs', async () => {
        const {
            windowStub, rendererLog,
        } = createWindowStub();
        vi.stubGlobal('window', windowStub);
        const sinks = spyOnConsole();
        const logger = await importBrowserLogger();
        const error = new RangeError('Invalid page during teardown');
        logger.warn('pdf-viewer', 'Failed to invalidate', {
            category: 'operation',
            error,
        });
        const captured = JSON.parse(JSON.stringify(sinks.warn.mock.calls[0]?.[1]));
        expect(captured.error).toMatchObject({
            name: 'RangeError',
            message: error.message,
            stack: error.stack,
        });
        expect(rendererLog).toHaveBeenCalledWith(expect.objectContaining({data: captured}));
    });

    it('suppresses everything at the silent level', async () => {
        const {
            windowStub,
            rendererLog,
        } = createWindowStub({logLevel: 'silent'});
        vi.stubGlobal('window', windowStub);
        const consoleSpies = spyOnConsole();
        const logger = await importBrowserLogger();

        logger.error('section-a', 'error message', undefined, EXISTING_RECEIPT);
        logger.warn('section-a', 'warn message');

        expect(consoleSpies.error).not.toHaveBeenCalled();
        expect(consoleSpies.warn).not.toHaveBeenCalled();
        expect(rendererLog).not.toHaveBeenCalled();
    });

    it('reuses a supplied receipt without recapturing and keeps the renderer log entry intact', async () => {
        const {
            windowStub,
            rendererLog,
        } = createWindowStub();
        vi.stubGlobal('window', windowStub);
        spyOnConsole();
        const logger = await importBrowserLogger();
        const receipt = createTestReceipt();

        expect(logger.error('section-a', 'existing receipt', {detail: 'kept locally'}, receipt)).toBe(receipt);
        expect(rendererLog).toHaveBeenCalledWith(expect.objectContaining({
            level: 'error',
            section: 'section-a',
            message: 'existing receipt',
            data: {detail: 'kept locally'},
            failureRef: receipt,
        }));
    });

    it('uses the sink captured before a console observer replaces console.error', async () => {
        const {windowStub} = createWindowStub();
        vi.stubGlobal('window', windowStub);
        const capturedSink = vi.spyOn(console, 'error').mockImplementation(() => {});
        const logger = await importBrowserLogger();
        const observer = vi.fn();
        console.error = observer;

        logger.error('section-a', 'observer must not recapture', undefined, EXISTING_RECEIPT);

        expect(capturedSink).toHaveBeenCalledOnce();
        expect(observer).not.toHaveBeenCalled();
    });
});
