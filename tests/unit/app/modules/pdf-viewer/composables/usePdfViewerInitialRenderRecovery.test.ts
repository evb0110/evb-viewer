import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import { usePdfViewerInitialRenderRecovery } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerInitialRenderRecovery';
import { cast } from '@tests/helpers/cast';

describe('usePdfViewerInitialRenderRecovery', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    function createHarness(options: {
        blockedTransactionAttempts?: number;
        container?: HTMLElement;
        isCurrent?: () => boolean;
        initialRenderError?: unknown;
        visibleRange?: {
            start: number;
            end: number
        };
        currentPage?: number;
        renderVisiblePages?: () => Promise<void>;
        isInitialCanvasCommitted?: () => boolean;
    } = {}) {
        const container = options.container ?? document.createElement('div');
        const renderVisiblePages = vi.fn(options.renderVisiblePages ?? (async () => {}));
        const syncCurrentPageFromViewport = vi.fn(async () => {});
        const onTerminalFailure = vi.fn();
        let activeTransactionId: number | null = null;
        let blockedTransactionAttempts = options.blockedTransactionAttempts ?? 0;
        let nextTransactionId = 1;
        const transactionController = {
            beginTransaction: vi.fn(() => {
                if (blockedTransactionAttempts > 0) {
                    blockedTransactionAttempts -= 1;
                    return null;
                }
                activeTransactionId = nextTransactionId;
                nextTransactionId += 1;
                return { id: activeTransactionId };
            }),
            advanceTransaction: vi.fn((transactionId: number, state: string) => {
                if (activeTransactionId !== transactionId) {
                    return false;
                }
                if (state === 'settled') {
                    activeTransactionId = null;
                }
                return true;
            }),
            isTransactionCurrent: vi.fn(
                (transactionId: number) => activeTransactionId === transactionId,
            ),
            commitVisibleRange: vi.fn(
                (_range: {
                    start: number;
                    end: number
                }, commitOptions?: { transactionId?: number | undefined }) =>
                    commitOptions?.transactionId === activeTransactionId,
            ),
        };
        const recovery = usePdfViewerInitialRenderRecovery({
            viewerContainer: ref(container),
            pdfDocument: shallowRef(cast<IPdfDocument>({})),
            numPages: ref(5),
            isLoading: ref(false),
            currentPage: ref(options.currentPage ?? 1),
            computeFitWidthScale: vi.fn(() => true),
            getVisibleRange: vi.fn(() => options.visibleRange ?? {
                start: 1,
                end: 1,
            }),
            updateVisibleRange: vi.fn(),
            renderVisiblePages,
            syncCurrentPageFromViewport,
            transactionController,
            isInitialCanvasCommitted: options.isInitialCanvasCommitted,
            onTerminalFailure,
        });

        recovery.scheduleRecoverInitialRender({
            isCurrent: options.isCurrent ?? (() => true),
            initialRenderError: options.initialRenderError,
        });

        return {
            container,
            recovery,
            renderVisiblePages,
            syncCurrentPageFromViewport,
            transactionController,
            onTerminalFailure,
        };
    }

    async function advanceRecovery(milliseconds: number) {
        await vi.advanceTimersByTimeAsync(milliseconds);
        await Promise.resolve();
    }

    it('does not start recovery when every visible page already has a canvas', async () => {
        const container = document.createElement('div');
        container.innerHTML = `
            <div class="page_container" data-page="1">
                <div class="page_canvas"><canvas></canvas></div>
            </div>
        `;
        const canvas = container.querySelector('canvas')!;
        canvas.width = 100;
        canvas.height = 100;
        document.body.append(container);
        const harness = createHarness({ container });

        await advanceRecovery(200);

        expect(harness.transactionController.beginTransaction).not.toHaveBeenCalled();
        expect(harness.renderVisiblePages).not.toHaveBeenCalled();
    });

    it('does not infer a stalled render while a successful canvas commit is delayed', async () => {
        const harness = createHarness();

        await advanceRecovery(60_000);

        expect(harness.transactionController.beginTransaction).not.toHaveBeenCalled();
        expect(harness.renderVisiblePages).not.toHaveBeenCalled();
        expect(harness.onTerminalFailure).not.toHaveBeenCalled();
    });

    it('runs one recovery transaction after the canonical initial render rejects', async () => {
        const harness = createHarness({ initialRenderError: new Error('render rejected') });

        await advanceRecovery(1);

        expect(harness.transactionController.beginTransaction).toHaveBeenCalledWith({
            kind: 'recovery',
            source: 'render-stall-recovery',
            page: 1,
            range: {
                start: 1,
                end: 1,
            },
            anchor: 'top',
        });
        expect(harness.renderVisiblePages).toHaveBeenCalledOnce();
    });

    it('waits for an authoritative transaction before starting recovery', async () => {
        const harness = createHarness({
            blockedTransactionAttempts: 2,
            initialRenderError: new Error('render rejected'),
        });

        await advanceRecovery(300);

        expect(harness.transactionController.beginTransaction).toHaveBeenCalledTimes(3);
        expect(harness.renderVisiblePages).toHaveBeenCalledOnce();
    });

    it('forces a zero-buffer visible render when the coordinated rerender paints no canvas', async () => {
        const harness = createHarness({ initialRenderError: new Error('render rejected') });

        await advanceRecovery(150);

        expect(harness.renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 1,
                end: 1,
            },
            {
                bufferOverride: 0,
                forceRerender: true,
            },
        );
        expect(harness.syncCurrentPageFromViewport).toHaveBeenCalledWith({
            source: 'render-stall-recovery',
            transactionId: 1,
        });
        expect(harness.transactionController.beginTransaction).toHaveBeenCalledOnce();
    });

    it('abandons recovery when its document context becomes stale during the wait', async () => {
        let isCurrent = true;
        const harness = createHarness({
            blockedTransactionAttempts: 1,
            isCurrent: () => isCurrent,
            initialRenderError: new Error('render rejected'),
        });
        isCurrent = false;

        await advanceRecovery(200);

        expect(harness.transactionController.beginTransaction).toHaveBeenCalledOnce();
        expect(harness.renderVisiblePages).not.toHaveBeenCalled();
    });

    it('uses the current restored page as success authority when an adjacent buffered canvas is absent', async () => {
        const container = document.createElement('div');
        container.innerHTML = `
            <div class="page_container" data-page="2">
                <div class="page_canvas"><canvas></canvas></div>
            </div>
            <div class="page_container" data-page="3">
                <div class="page_canvas"></div>
            </div>
        `;
        const currentCanvas = container.querySelector<HTMLCanvasElement>(
            '.page_container[data-page="2"] canvas',
        )!;
        currentCanvas.width = 100;
        currentCanvas.height = 100;
        document.body.append(container);
        const harness = createHarness({
            container,
            currentPage: 2,
            visibleRange: {
                start: 2,
                end: 3,
            },
        });

        await advanceRecovery(50);

        expect(harness.renderVisiblePages).not.toHaveBeenCalled();
        expect(harness.onTerminalFailure).not.toHaveBeenCalled();
    });

    it('does not report failure after the shared open surface commits the restored page', async () => {
        let committed = false;
        const harness = createHarness({
            currentPage: 5,
            visibleRange: {
                start: 4,
                end: 5,
            },
            initialRenderError: new Error('render rejected'),
            isInitialCanvasCommitted: () => committed,
        });

        await advanceRecovery(50);
        committed = true;
        await advanceRecovery(8_100);

        expect(harness.onTerminalFailure).not.toHaveBeenCalled();
    });

    it('surfaces failure only when the current bounded recovery explicitly rejects', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const initialRenderError = new Error('initial render failed');
        const recoveryError = new Error('recovery render failed');
        const harness = createHarness({
            initialRenderError,
            renderVisiblePages: async () => { throw recoveryError; },
        });

        await advanceRecovery(1);

        expect(harness.onTerminalFailure).toHaveBeenCalledOnce();
        const [terminalError] = harness.onTerminalFailure.mock.calls[0] as [Error];
        expect(terminalError.message).toContain('bounded recovery transaction');
        expect(terminalError.cause).toBe(recoveryError);
    });

    it('lets a current-generation canvas commit win over a late recovery rejection', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        let committed = false;
        let rejectRecovery!: (error: Error) => void;
        const harness = createHarness({
            initialRenderError: new Error('initial render failed'),
            isInitialCanvasCommitted: () => committed,
            renderVisiblePages: () => new Promise<void>((_resolve, reject) => {
                rejectRecovery = reject;
            }),
        });

        await advanceRecovery(1);
        committed = true;
        rejectRecovery(new Error('late recovery rejection'));
        await Promise.resolve();
        await Promise.resolve();

        expect(harness.onTerminalFailure).not.toHaveBeenCalled();
    });

    it('does not report terminal failure after the document context is invalidated', async () => {
        let isCurrent = true;
        const harness = createHarness({
            blockedTransactionAttempts: 4,
            isCurrent: () => isCurrent,
            initialRenderError: new Error('render rejected'),
        });

        await advanceRecovery(700);
        isCurrent = false;
        await advanceRecovery(1_000);

        expect(harness.onTerminalFailure).not.toHaveBeenCalled();
    });
});
