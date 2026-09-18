import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import type * as FailureReporterModule from '@app/utils/failureReporter';
import { parseDiagnosticEventId } from '@contracts/diagnostics/diagnosticEventId';
import type { FailureReceipt } from '@contracts/diagnostics/failureReceipt';
import {requireEpochMs} from '@contracts/timestamps';

const LOG_LEVEL_STORAGE_KEY = 'evb-viewer:log-level';
function createTestReceipt(
    eventId = '0123456789abcdef0123456789abcdef',
): FailureReceipt {
    return {
        eventId: parseDiagnosticEventId(eventId)!,
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
        log: vi.spyOn(console, 'log').mockImplementation(() => {}),
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

        expect(consoleSpies.log).not.toHaveBeenCalled();
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

        expect(consoleSpies.log).not.toHaveBeenCalled();
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

        expect(consoleSpies.log).toHaveBeenCalledTimes(1);
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

        expect(consoleSpies.log).not.toHaveBeenCalled();
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

        expect(consoleSpies.log).toHaveBeenCalledTimes(1);
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
        expect(consoleSpies.log).not.toHaveBeenCalled();
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

        expect(consoleSpies.log).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date('2026-01-01T00:00:01.500Z'));
        logger.diagnosticThrottled('section-a', 'key-1', 1_000, 'tick', {sequence: 4});

        expect(consoleSpies.log).toHaveBeenCalledTimes(2);
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

    it('captures a classified receipt while retaining the full local log entry', async () => {
        const {
            windowStub,
            rendererLog,
        } = createWindowStub();
        vi.stubGlobal('window', windowStub);
        spyOnConsole();
        const captureRendererFailure = vi.fn();
        const sender = vi.fn();
        const actualFailureReporter = await vi.importActual<typeof FailureReporterModule>(
            '@app/utils/failureReporter',
        );
        const reporter = actualFailureReporter.createRendererFailureReporter({
            host: 'electron',
            preference: 'granted',
            electronSender: sender,
        });
        const initializeRendererFailureReporter = vi.fn(() => reporter);
        vi.doMock('@app/utils/failureReporter', () => ({
            captureRendererFailure,
            initializeRendererFailureReporter,
        }));
        const logger = await importBrowserLogger();
        const localOnlyMessage = 'private BrowserLogger error detail';
        const localOnlyCause = new Error('private BrowserLogger error cause');

        const receipt = logger.error('browser-logger-test', localOnlyMessage, {
            cause: localOnlyCause,
            argument: 'private BrowserLogger argument',
        }, {
            code: 'RENDERER_WORKSPACE_OPERATION_FAILED',
            context: {},
        });

        expect(receipt).toMatchObject({
            code: 'RENDERER_WORKSPACE_OPERATION_FAILED',
            severity: 'error',
        });
        expect(captureRendererFailure).toHaveBeenCalledWith(expect.objectContaining({
            code: 'RENDERER_WORKSPACE_OPERATION_FAILED',
            context: {},
            local: expect.objectContaining({
                cause: expect.objectContaining({
                    argument: 'private BrowserLogger argument',
                    cause: expect.any(Error),
                }),
                data: expect.objectContaining({argument: 'private BrowserLogger argument'}),
                message: localOnlyMessage,
                source: 'browser-logger-test',
            }),
        }), {localAlreadyRecorded: true});
        expect(initializeRendererFailureReporter).toHaveBeenCalledWith({host: 'electron'});
        expect(sender).toHaveBeenCalledWith(expect.objectContaining({
            code: 'RENDERER_WORKSPACE_OPERATION_FAILED',
            runtime: 'electron-renderer',
        }));
        const record = sender.mock.calls[0]?.[0];
        expect(record.frames).not.toContainEqual(expect.objectContaining({module: 'app/utils/browserLogger.ts'}));
        expect(JSON.stringify(record)).not.toContain(localOnlyMessage);
        expect(JSON.stringify(record)).not.toContain('private BrowserLogger error cause');
        expect(JSON.stringify(record)).not.toContain('private BrowserLogger argument');
        expect(rendererLog).toHaveBeenCalledWith(expect.objectContaining({
            level: 'error',
            section: 'browser-logger-test',
            message: localOnlyMessage,
            data: expect.objectContaining({
                cause: expect.objectContaining({message: 'private BrowserLogger error cause'}),
                argument: 'private BrowserLogger argument',
            }),
        }));
    });

    it('captures typed renderer failures with only closed remote fields', async () => {
        const {
            windowStub,
            rendererLog,
        } = createWindowStub();
        vi.stubGlobal('window', windowStub);
        spyOnConsole();
        const captureRendererFailure = vi.fn();
        const sender = vi.fn();
        const actualFailureReporter = await vi.importActual<typeof FailureReporterModule>(
            '@app/utils/failureReporter',
        );
        const reporter = actualFailureReporter.createRendererFailureReporter({
            host: 'electron',
            preference: 'granted',
            electronSender: sender,
        });
        vi.doMock('@app/utils/failureReporter', () => ({
            captureRendererFailure,
            initializeRendererFailureReporter: vi.fn(() => reporter),
        }));
        const logger = await importBrowserLogger();

        const receipt = logger.error(
            'browser-logger-test',
            'private typed renderer detail',
            {
                cause: new Error('private typed cause'),
                secret: 'private typed value',
            },
            {
                code: 'RENDERER_PDF_SEARCH_OPERATION_FAILED',
                context: {operation: 'apply-highlights'},
            },
        );

        expect(receipt).toMatchObject({
            code: 'RENDERER_PDF_SEARCH_OPERATION_FAILED',
            severity: 'error',
        });
        expect(captureRendererFailure).toHaveBeenCalledWith(expect.objectContaining({
            code: 'RENDERER_PDF_SEARCH_OPERATION_FAILED',
            context: {operation: 'apply-highlights'},
            local: expect.objectContaining({message: 'private typed renderer detail'}),
        }), {localAlreadyRecorded: true});
        const record = sender.mock.calls[0]?.[0];
        expect(record).toMatchObject({
            code: 'RENDERER_PDF_SEARCH_OPERATION_FAILED',
            context: {operation: 'apply-highlights'},
        });
        expect(JSON.stringify(record)).not.toContain('private typed renderer detail');
        expect(JSON.stringify(record)).not.toContain('private typed cause');
        expect(JSON.stringify(record)).not.toContain('private typed value');
        expect(rendererLog).toHaveBeenCalledWith(expect.objectContaining({message: 'private typed renderer detail'}));
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

    it('initializes and uses the shared reporter before the plugin is ready', async () => {
        const {windowStub} = createWindowStub();
        vi.stubGlobal('window', windowStub);
        spyOnConsole();
        const captureRendererFailure = vi.fn();
        const capture = vi.fn();
        const initializeRendererFailureReporter = vi.fn(() => ({capture}));
        vi.doMock('@app/utils/failureReporter', () => ({
            captureRendererFailure,
            initializeRendererFailureReporter,
        }));
        const logger = await importBrowserLogger();
        const receipt = createTestReceipt('fedcba9876543210fedcba9876543210');
        capture.mockReturnValue(receipt);

        expect(logger.error('early-startup', 'Reporter is not ready', undefined, {
            code: 'RENDERER_STARTUP_WARMUP_FAILED',
            context: {},
        })).toBe(receipt);

        expect(initializeRendererFailureReporter).toHaveBeenCalledWith({host: 'electron'});
        expect(capture).toHaveBeenCalledWith(expect.objectContaining({code: 'RENDERER_STARTUP_WARMUP_FAILED'}), {localAlreadyRecorded: true});
        expect(captureRendererFailure).toHaveBeenCalledOnce();
    });

    it('captures the closed unclassified fallback instead of throwing on invalid runtime input', async () => {
        const {windowStub} = createWindowStub();
        vi.stubGlobal('window', windowStub);
        const consoleSpies = spyOnConsole();
        const captureRendererFailure = vi.fn();
        const receipt = createTestReceipt('11111111111111111111111111111111');
        const capture = vi.fn(() => receipt);
        vi.doMock('@app/utils/failureReporter', () => ({
            captureRendererFailure,
            initializeRendererFailureReporter: vi.fn(() => ({capture})),
        }));
        const logger = await importBrowserLogger();

        expect(logger.error('invalid-runtime-call', 'still owned', undefined, undefined as never)).toBe(receipt);
        expect(capture).toHaveBeenCalledWith(expect.objectContaining({
            code: 'UNCLASSIFIED_RENDERER_ERROR',
            context: {phase: 'operation'},
        }), {localAlreadyRecorded: true});
        expect(consoleSpies.warn).toHaveBeenCalledWith(expect.stringContaining('closed unclassified fallback'));
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
