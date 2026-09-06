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

function rect(left: number, top: number, width: number, height: number): DOMRect {
    return {
        bottom: top + height,
        height,
        left,
        right: left + width,
        top,
        width,
        x: left,
        y: top,
        toJSON: () => ({}),
    };
}

function createHarness(options: {
    currentPage?: number;
    currentPagePhysicallyVisible?: boolean;
    numPages?: number;
    visibleRange?: {
        start: number;
        end: number;
    };
} = {}) {
    const currentPage = options.currentPage ?? 6;
    const documentA = cast<IPdfDocument>({fingerprint: 'a'});
    const pdfDocument = shallowRef<IPdfDocument | null>(documentA);
    const isActive = ref(true);
    const visibleRange = ref(options.visibleRange ?? {
        start: 1,
        end: 2,
    });
    const renderVisiblePages = vi.fn(async () => {});
    const scrollToPage = vi.fn();
    const applySearchHighlights = vi.fn();
    const viewerContainer = document.createElement('div');
    Object.defineProperties(viewerContainer, {
        clientHeight: {value: 700},
        clientWidth: {value: 900},
    });
    viewerContainer.getBoundingClientRect = () => rect(0, 0, 900, 700);
    const pageContainer = document.createElement('div');
    pageContainer.className = 'page_container';
    pageContainer.dataset.page = String(currentPage);
    const canvasHost = document.createElement('div');
    canvasHost.className = 'page_canvas';
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 800;
    canvas.getBoundingClientRect = () => options.currentPagePhysicallyVisible === false
        ? rect(0, 1_440_000, 600, 800)
        : rect(0, 0, 600, 800);
    canvasHost.append(canvas);
    pageContainer.append(canvasHost);
    viewerContainer.append(pageContainer);
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
        getVisiblePageRange: () => visibleRange.value,
        updateVisibleRange: vi.fn(),
        scrollToPage,
        renderVisiblePages,
        applySearchHighlights,
    });
    return {
        applySearchHighlights,
        isActive,
        pdfDocument,
        renderVisiblePages,
        restore,
        scrollToPage,
    };
}

describe('usePdfViewerActivationRestore', () => {
    it('resumes through one semantic scroll and one normal render demand', async () => {
        const harness = createHarness();
        const runId = harness.restore.nextActivationRestoreRunId();

        await harness.restore.renderActiveDocumentAfterActivation(runId);

        expect(harness.scrollToPage).toHaveBeenCalledOnce();
        expect(harness.scrollToPage).toHaveBeenCalledWith(6);
        expect(harness.renderVisiblePages).toHaveBeenCalledOnce();
        expect(harness.renderVisiblePages).toHaveBeenCalledWith({
            start: 5,
            end: 6,
        }, {preserveRenderedPages: true});
        expect(harness.applySearchHighlights).toHaveBeenCalledOnce();
    });

    it('reanchors a restored deep page when cached visibility says it is visible but its canvas is physically offscreen', async () => {
        const harness = createHarness({
            currentPage: 500,
            currentPagePhysicallyVisible: false,
            numPages: 1_200,
            visibleRange: {
                start: 482,
                end: 518,
            },
        });
        const runId = harness.restore.nextActivationRestoreRunId();

        await harness.restore.renderActiveDocumentAfterActivation(runId);

        expect(harness.scrollToPage).toHaveBeenCalledExactlyOnceWith(500);
        expect(harness.renderVisiblePages).toHaveBeenCalledExactlyOnceWith({
            start: 499,
            end: 500,
        }, {preserveRenderedPages: true});
    });

    it('fences a late completion after a newer activation run', async () => {
        const harness = createHarness();
        let finish!: () => void;
        harness.renderVisiblePages.mockImplementationOnce(() => new Promise<void>((resolve) => {
            finish = resolve;
        }));
        const oldRun = harness.restore.nextActivationRestoreRunId();
        const pending = harness.restore.renderActiveDocumentAfterActivation(oldRun);
        await vi.waitFor(() => expect(harness.renderVisiblePages).toHaveBeenCalledOnce());
        harness.restore.nextActivationRestoreRunId();
        finish();
        await pending;

        expect(harness.applySearchHighlights).not.toHaveBeenCalled();
    });

    it('fences a late completion after the document changes', async () => {
        const harness = createHarness();
        harness.renderVisiblePages.mockImplementationOnce(async () => {
            harness.pdfDocument.value = cast<IPdfDocument>({fingerprint: 'b'});
        });
        const runId = harness.restore.nextActivationRestoreRunId();
        await harness.restore.renderActiveDocumentAfterActivation(runId);
        expect(harness.applySearchHighlights).not.toHaveBeenCalled();
    });
});
