// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import {createPdfThumbnailScrollController} from '@app/modules/pdf-viewer/thumbnails/createPdfThumbnailScrollController';
import type {IDocumentThumbnailScrollSegmentTransition} from '@app/modules/document-viewer/thumbnails/documentThumbnailLayout';
import {createTestPdfViewportWritePort} from '@tests/helpers/createTestPdfViewportWritePort';

type TResolveSegmentTransition = (
    scrollTop: number,
    previousScrollTop: number,
    viewportHeight: number,
) => IDocumentThumbnailScrollSegmentTransition | null;

const pendingFrames: FrameRequestCallback[] = [];

afterEach(() => {
    pendingFrames.splice(0);
    vi.unstubAllGlobals();
});

function createContainer() {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientHeight', {
        configurable: true,
        value: 500,
    });
    document.body.append(container);
    return container;
}

function flushFrame() {
    const callbacks = pendingFrames.splice(0);
    callbacks.forEach(callback => callback(0));
}

function createController(
    container: HTMLElement,
    activeSegmentIndex = ref(0),
) {
    const updateScrollPosition = vi.fn();
    const updateViewportMetrics = vi.fn();
    const scheduleVisibleThumbnailRender = vi.fn();
    const markManualScroll = vi.fn();
    const markProgrammaticScroll = vi.fn();
    const resolveSegmentTransition = vi.fn<TResolveSegmentTransition>(() => null);
    const {port: viewportWritePort} = createTestPdfViewportWritePort();
    const controller = createPdfThumbnailScrollController({
        activeSegmentIndex,
        containerRef: ref(container),
        getMaxScrollTop: clientHeight => Math.max(0, 2_000 - clientHeight),
        getPageBounds: page => ({
            bottom: page * 100,
            height: 100,
            top: (page - 1) * 100,
        }),
        getThumbnailElement: () => null,
        getViewport: currentContainer => ({
            clientHeight: currentContainer.clientHeight,
            scrollHeight: 2_000,
            scrollTop: currentContainer.scrollTop,
        }),
        isRecentProgrammaticScroll: () => false,
        markManualScroll,
        markProgrammaticScroll,
        resolveSegmentTransition,
        scheduleVisibleThumbnailRender,
        setActiveSegmentForPage: page => {
            activeSegmentIndex.value = page > 10 ? 1 : 0;
            return true;
        },
        updateScrollPosition,
        updateViewportMetrics,
        viewportWritePort,
    });
    return {
        controller,
        markManualScroll,
        markProgrammaticScroll,
        resolveSegmentTransition,
        scheduleVisibleThumbnailRender,
        updateScrollPosition,
        updateViewportMetrics,
    };
}

describe('createPdfThumbnailScrollController', () => {
    it('applies programmatic page reveals while keeping the segment anchor in sync', () => {
        const container = createContainer();
        const harness = createController(container);

        expect(harness.controller.applyScrollTop(container, 120)).toBe(true);
        expect(container.scrollTop).toBe(120);
        expect(harness.markProgrammaticScroll).toHaveBeenCalledTimes(1);
        expect(harness.updateViewportMetrics).toHaveBeenCalledTimes(1);
        expect(harness.scheduleVisibleThumbnailRender).toHaveBeenCalledTimes(1);
    });

    it('retries a clamped programmatic reveal after the PDF wrapper grows', async () => {
        const container = createContainer();
        let maxScrollTop = 100;
        let scrollTop = 0;
        Object.defineProperty(container, 'scrollTop', {
            configurable: true,
            get: () => scrollTop,
            set: (value: number) => {
                scrollTop = Math.min(Math.max(0, value), maxScrollTop);
            },
        });
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            pendingFrames.push(callback);
            return pendingFrames.length;
        });
        const harness = createController(container);

        harness.controller.applyScrollTop(container, 500);
        expect(container.scrollTop).toBe(100);
        await nextTick();
        expect(pendingFrames).toHaveLength(1);

        maxScrollTop = 600;
        flushFrame();
        await nextTick();

        expect(container.scrollTop).toBe(500);
    });

    it('moves to the next physical segment after a forward boundary scroll', async () => {
        const container = createContainer();
        const activeSegmentIndex = ref(0);
        const harness = createController(container, activeSegmentIndex);
        harness.resolveSegmentTransition.mockImplementationOnce(() => {
            activeSegmentIndex.value = 1;
            return {
                scrollTop: 0,
                segmentIndex: 1,
            };
        });
        container.scrollTop = 1_000;

        harness.controller.handleContainerScroll();
        expect(activeSegmentIndex.value).toBe(1);
        expect(container.scrollTop).toBe(1_000);

        await nextTick();

        expect(container.scrollTop).toBe(0);
        expect(harness.markProgrammaticScroll).toHaveBeenCalledTimes(1);
        expect(harness.updateScrollPosition).toHaveBeenCalledTimes(1);
        expect(harness.updateViewportMetrics).toHaveBeenCalledTimes(1);
    });
});
