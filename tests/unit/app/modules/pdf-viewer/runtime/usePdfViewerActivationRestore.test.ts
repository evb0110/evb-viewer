import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
// @vitest-environment happy-dom

import {
    computed,
    ref,
    shallowRef,
} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfViewerActivationRestore } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerActivationRestore';
import { cast } from '@tests/helpers/cast';

function createHarness(options: {
    currentPage?: number;
    numPages?: number;
    visibleRange?: {
        start: number;
        end: number;
    };
    measuredRange?: {
        start: number;
        end: number;
    } | null;
} = {}) {
    const currentPage = options.currentPage ?? 6;
    const documentA = cast<IPdfDocument>({fingerprint: 'a'});
    const pdfDocument = shallowRef<IPdfDocument | null>(documentA);
    const isActive = ref(true);
    const visibleRange = ref(options.visibleRange ?? {
        start: 1,
        end: 2,
    });
    // The viewer as the user sees it: which pages hold painted pixels and
    // whether search highlights are drawn.
    const view = {
        paintedPages: new Set<number>(),
        highlightsDrawn: false,
    };
    const renderVisiblePages = vi.fn(async (range: {
        start: number;
        end: number;
    }) => {
        for (let page = range.start; page <= range.end; page += 1) {
            view.paintedPages.add(page);
        }
    });
    const viewerContainer = document.createElement('div');
    Object.defineProperties(viewerContainer, {
        clientHeight: {value: 700},
        clientWidth: {value: 900},
    });
    document.body.append(viewerContainer);
    const restore = usePdfViewerActivationRestore({
        viewerContainer: ref(viewerContainer),
        pdfDocument,
        isActive: computed(() => isActive.value),
        isLoading: ref(false),
        numPages: ref(options.numPages ?? 8),
        currentPage: ref(currentPage),
        visibleRange,
        viewMode: computed(() => 'facing'),
        getVisiblePageRange: () => options.measuredRange === undefined ? visibleRange.value : options.measuredRange,
        renderVisiblePages,
        applySearchHighlights: () => {
            view.highlightsDrawn = true;
        },
    });
    return {
        isActive,
        pdfDocument,
        renderVisiblePages,
        restore,
        view,
        visibleRange,
    };
}

describe('usePdfViewerActivationRestore', () => {
    it('paints the current facing row and redraws search highlights', async () => {
        const harness = createHarness();
        const runId = harness.restore.nextActivationRestoreRunId();

        await harness.restore.renderActiveDocumentAfterActivation(runId);

        expect([...harness.view.paintedPages]).toEqual([
            5,
            6,
        ]);
        expect(harness.view.highlightsDrawn).toBe(true);
    });

    it('retains deep-page demand while activation has no measured visibility', async () => {
        const harness = createHarness({
            currentPage: 500,
            measuredRange: null,
            numPages: 1_200,
            visibleRange: {
                start: 482,
                end: 518,
            },
        });
        const runId = harness.restore.nextActivationRestoreRunId();

        await harness.restore.renderActiveDocumentAfterActivation(runId);

        expect(harness.visibleRange.value).toEqual({
            start: 482,
            end: 518,
        });
        expect([...harness.view.paintedPages]).toEqual([
            499,
            500,
        ]);
    });

    it('fences a late completion after a newer activation run', async () => {
        const harness = createHarness();
        let finish!: () => void;
        harness.renderVisiblePages.mockImplementationOnce(() => new Promise<void>((resolve) => {
            finish = resolve;
        }));
        const oldRun = harness.restore.nextActivationRestoreRunId();
        const pending = harness.restore.renderActiveDocumentAfterActivation(oldRun);
        await vi.waitFor(() => expect(finish).toBeDefined());
        harness.restore.nextActivationRestoreRunId();
        finish();
        await pending;

        expect(harness.view.highlightsDrawn).toBe(false);
    });

    it('fences a late completion after the document changes', async () => {
        const harness = createHarness();
        harness.renderVisiblePages.mockImplementationOnce(async () => {
            harness.pdfDocument.value = cast<IPdfDocument>({fingerprint: 'b'});
        });
        const runId = harness.restore.nextActivationRestoreRunId();
        await harness.restore.renderActiveDocumentAfterActivation(runId);
        expect(harness.view.highlightsDrawn).toBe(false);
    });
});
