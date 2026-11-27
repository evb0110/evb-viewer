import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {BrowserLogger} from '@app/utils/browserLogger';
import {logPdfNav} from '@app/utils/logPdfNav';
import {isPdfRenderTraceEnabled, logPdfRenderTrace} from '@app/utils/pdfRenderTrace';
import {disablePdfDiagnosticSession, enablePdfDiagnosticSession} from '@tests/e2e/electron/helpers/pdfDiagnosticSession';
import type {Page} from 'puppeteer-core';

vi.mock('@app/utils/browserLogger', () => ({
    BrowserLogger: {
        diagnostic: vi.fn(),
        warn: vi.fn(),
    },
}));

interface IDiagnosticWindowStub {
    __pdfNavLog?: boolean;
    __pdfNavLogBuffer?: unknown[];
    __pdfNavLogConsole?: boolean;
    __pdfRenderTrace?: boolean;
    __pdfRenderTraceBuffer?: unknown[];
    __pdfRenderTraceConsole?: boolean;
    localStorage: {getItem: ReturnType<typeof vi.fn>};
}

function createWindowStub(): IDiagnosticWindowStub {
    return {localStorage: {getItem: vi.fn(() => '1')}};
}

describe('PDF diagnostic session flags', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('ignores stale durable trace keys when no session flag is active', () => {
        const windowStub = createWindowStub();
        vi.stubGlobal('window', windowStub);

        logPdfNav('stale navigation trace');
        logPdfRenderTrace('stale render trace');

        expect(isPdfRenderTraceEnabled()).toBe(false);
        expect(windowStub.localStorage.getItem).not.toHaveBeenCalled();
        expect(windowStub.__pdfNavLogBuffer).toBeUndefined();
        expect(windowStub.__pdfRenderTraceBuffer).toBeUndefined();
        expect(BrowserLogger.diagnostic).not.toHaveBeenCalled();
        expect(BrowserLogger.warn).not.toHaveBeenCalled();
    });

    it('buffers and emits traces only while explicit window flags are active', () => {
        const windowStub = createWindowStub();
        windowStub.__pdfNavLog = true;
        windowStub.__pdfNavLogConsole = true;
        windowStub.__pdfRenderTrace = true;
        windowStub.__pdfRenderTraceConsole = true;
        vi.stubGlobal('window', windowStub);

        logPdfNav('session navigation trace', {page: 3});
        logPdfRenderTrace('session render trace', {pageNumber: 3});

        expect(isPdfRenderTraceEnabled()).toBe(true);
        expect(windowStub.localStorage.getItem).not.toHaveBeenCalled();
        expect(windowStub.__pdfNavLogBuffer).toHaveLength(1);
        expect(windowStub.__pdfRenderTraceBuffer).toHaveLength(1);
        expect(BrowserLogger.diagnostic).toHaveBeenCalledTimes(1);
        expect(BrowserLogger.warn).toHaveBeenCalledTimes(1);
    });

    it('clears all session-scoped flags, buffers, and readers on teardown', async () => {
        const windowStub = createWindowStub();
        vi.stubGlobal('window', windowStub);
        const evaluateInStub = async (callback: (...args: never[]) => unknown, argument?: unknown) =>
            argument === undefined ? callback() : callback(argument as never);
        const page = {evaluate: evaluateInStub} as Pick<Page, 'evaluate'>;

        await enablePdfDiagnosticSession(page, {
            console: true,
            navigation: true,
            render: true,
        });
        expect(windowStub.__pdfNavLog).toBe(true);
        expect(windowStub.__pdfRenderTrace).toBe(true);

        await disablePdfDiagnosticSession(page);
        expect(windowStub).not.toHaveProperty('__pdfNavLog');
        expect(windowStub).not.toHaveProperty('__pdfNavLogBuffer');
        expect(windowStub).not.toHaveProperty('__pdfRenderTrace');
        expect(windowStub).not.toHaveProperty('__pdfRenderTraceBuffer');
    });

    it('skips lazy payload evaluation when render tracing is disabled and bounds buffered entries when enabled', () => {
        const windowStub = createWindowStub() as IDiagnosticWindowStub & {
            __getPdfRenderTrace?: () => Array<{
                event: string;
                payload: Record<string, unknown>;
            }>;
        };
        vi.stubGlobal('window', windowStub);

        const disabledPayload = vi.fn(() => ({pageNumber: 1}));
        logPdfRenderTrace('disabled-event', disabledPayload);
        expect(disabledPayload).not.toHaveBeenCalled();

        windowStub.__pdfRenderTrace = true;
        for (let index = 0; index < 21_500; index += 1) {
            logPdfRenderTrace('burst', () => ({index}));
        }

        const snapshot = windowStub.__getPdfRenderTrace?.() ?? [];
        expect(snapshot).toHaveLength(20_000);
        expect(snapshot[0]?.payload.index).toBe(1_500);
        expect(snapshot.at(-1)?.payload.index).toBe(21_499);
    });

    it('clamps __getPdfRenderTrace to the 20,000-entry limit when enabled through enablePdfDiagnosticSession', async () => {
        const windowStub = createWindowStub() as IDiagnosticWindowStub & {
            __getPdfRenderTrace?: () => Array<{
                event: string;
                payload: Record<string, unknown>;
            }>;
        };
        vi.stubGlobal('window', windowStub);
        const evaluateInStub = async (callback: (...args: never[]) => unknown, argument?: unknown) =>
            argument === undefined ? callback() : callback(argument as never);
        const page = {evaluate: evaluateInStub} as Pick<Page, 'evaluate'>;

        await enablePdfDiagnosticSession(page, {render: true});
        for (let index = 0; index < 20_500; index += 1) {
            logPdfRenderTrace('e2e-burst', () => ({index}));
        }

        const snapshot = windowStub.__getPdfRenderTrace?.() ?? [];
        expect(snapshot).toHaveLength(20_000);
        expect(snapshot[0]?.payload.index).toBe(500);
        expect(snapshot.at(-1)?.payload.index).toBe(20_499);
    });
});
