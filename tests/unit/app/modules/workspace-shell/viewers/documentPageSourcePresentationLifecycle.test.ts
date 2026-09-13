// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createDocumentPageSourcePresentation,
    type IDocumentPageSourceVisualState,
} from '@app/modules/workspace-shell/viewers/documentPageSourcePresentation';
import type {
    IDocumentPageSource,
    IDocumentSurfaceLease,
} from '@app/modules/document-viewer/source/documentPageSource';
import type { IDocumentViewerRenderSession } from '@app/modules/document-viewer/chassis/createDocumentViewerRenderCoordinator';
import type { FailureReceipt } from '@contracts/diagnostics/failureReceipt';
import { BrowserLogger } from '@app/utils/browserLogger';
import { createDiagnosticEventId } from '@contracts/diagnostics/diagnosticEventId';
import { requireEpochMs } from '@contracts/timestamps';
import { requireDocumentRef } from '@contracts/documentRef';
import { createDocumentPageSlotRegistry } from '@app/modules/document-viewer/page-slots/createDocumentPageSlotRegistry';

function createCurrentTargetEvent(target: EventTarget): Event {
    const event = new Event('load');
    Object.defineProperty(event, 'currentTarget', {
        configurable: true,
        value: target,
    });
    return event;
}

function createPresentationHarness() {
    const documentRef = requireDocumentRef('/documents/scan.djvu');
    const viewport = document.createElement('div');
    Object.defineProperties(viewport, {
        clientHeight: {value: 600},
        clientWidth: {value: 800},
    });
    const page = document.createElement('section');
    page.dataset.testid = 'document-page-source-page';
    page.dataset.pageNumber = '1';
    const image = document.createElement('img');
    image.dataset.testid = 'document-page-source-image';
    image.dataset.documentLoadGeneration = '1';
    image.dataset.openSurfaceGeneration = '';
    image.dataset.pageRenderGeneration = '1';
    Object.defineProperties(image, {
        complete: {value: true},
        naturalWidth: {value: 100},
    });
    page.append(image);
    viewport.append(page);
    document.body.append(viewport);
    const fence = Object.freeze({
        documentRevision: 'revision-a',
        loadGeneration: 1,
        openSurfaceGeneration: null,
        src: documentRef,
    });
    const loadController = new AbortController();
    const oldRelease = vi.fn();
    const oldUnsubscribeInvalidation = vi.fn();
    let invalidateOldLease = () => {};
    const oldLease: IDocumentSurfaceLease = {
        bytes: 40_000,
        heightPx: 100,
        onInvalidated(listener) {
            invalidateOldLease = listener;
            return oldUnsubscribeInvalidation;
        },
        release: oldRelease,
        surface: 'old-surface',
        widthPx: 100,
    };
    let resolveReplacement!: (lease: IDocumentSurfaceLease) => void;
    const replacement = new Promise<IDocumentSurfaceLease>((resolve) => {
        resolveReplacement = resolve;
    });
    const source: IDocumentPageSource = {
        dispose: vi.fn(),
        documentRef,
        getPageMetrics: vi.fn(async () => ({
            heightPoints: 100,
            rotation: 0 as const,
            widthPoints: 100,
        })),
        kind: 'djvu',
        pageCount: 1,
        renderPage: vi.fn(() => replacement),
    };
    let nextRenderGeneration = 1;
    const renderSession: IDocumentViewerRenderSession = {
        ownerId: 'presentation-test',
        pageSlots: createDocumentPageSlotRegistry().createOwner('presentation-test'),
        beginPageRender: () => ++nextRenderGeneration,
        commitPageRender: () => true,
        failPageRender: () => true,
        getPageVisual: () => 'skeleton',
        resolveMountedPages: () => [],
        dispose: vi.fn(),
        releasePage: vi.fn(),
        runPageRender: async <T>(
            _pageNumber: number,
            render: (generation: number) => Promise<T>,
        ) => {
            const generation = ++nextRenderGeneration;
            return {
                committed: true,
                generation,
                value: await render(generation),
            };
        },
    };
    const renderMountedPages = vi.fn(async () => {});
    const emit = vi.fn();
    const scheduleRender = vi.fn();
    let pageScale = 2;
    const presentation = createDocumentPageSourcePresentation({
        chassisAuthority: null,
        emit,
        ensureExactPageMetric: vi.fn(async () => ({
            heightPoints: 100,
            rotation: 0 as const,
            widthPoints: 100,
        })),
        flushMetricPublication: vi.fn(),
        getOpeningTarget: () => null,
        isFenceCurrent: candidate => candidate === fence,
        openSurfaceRenderOwner: undefined,
        readContinuousScroll: () => false,
        readCurrentPage: () => 1,
        readFence: () => fence,
        readIsActive: () => true,
        readLoadSignal: () => loadController.signal,
        readMetric: () => ({
            heightPoints: 100,
            rotation: 0,
            widthPoints: 100,
        }),
        readPageScale: () => pageScale,
        readPixelRatio: () => 1,
        readRenderDemand: () => ({
            bufferPages: [],
            residentPages: [1],
            visiblePages: [1],
        }),
        readSource: () => source,
        readViewport: () => viewport,
        readViewportScrollDirection: () => 0,
        renderSession,
        scheduleRender,
    });
    const state: IDocumentPageSourceVisualState = reactive({
        error: null,
        failurePresentation: null,
        generation: 1,
        lease: oldLease,
        priority: 'navigation',
        ready: true,
        retryCount: 0,
        unsubscribeInvalidation: null,
        widthPx: 100,
    });
    presentation.pageStates.set(1, state);
    return {
        emit,
        fence,
        image,
        invalidateOldLease: () => invalidateOldLease(),
        oldLease,
        oldRelease,
        oldUnsubscribeInvalidation,
        presentation,
        page,
        renderMountedPages,
        resolveReplacement,
        scheduleRender,
        setPageScale: (value: number) => {
            pageScale = value;
        },
        source,
        viewport,
    };
}

describe('document page-source presentation lifecycle', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('retains a painted lease through restore until its replacement commits', async () => {
        const harness = createPresentationHarness();
        let resolveDecode!: () => void;
        vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(() => new Promise((resolve) => {
            resolveDecode = resolve;
        }));
        const transition = {
            fence: harness.fence,
            isCurrent: () => true,
            kind: 'restore' as const,
        };
        const restore = harness.presentation.restore(transition, {
            measureViewport: vi.fn(),
            renderMountedPages: harness.renderMountedPages,
        });
        await vi.waitFor(() => expect(harness.source.renderPage).toHaveBeenCalledOnce());
        expect(harness.oldRelease).not.toHaveBeenCalled();
        expect(harness.presentation.pageStates.get(1)?.lease?.surface).toBe(harness.oldLease.surface);

        const replacementLease: IDocumentSurfaceLease = {
            bytes: 160_000,
            heightPx: 200,
            release: vi.fn(),
            surface: 'replacement-surface',
            widthPx: 200,
        };
        harness.resolveReplacement(replacementLease);
        const replacementImage = await vi.waitFor(() => {
            const candidate = harness.page.querySelector<HTMLImageElement>(
                '[data-page-source-candidate]',
            );
            expect(candidate?.isConnected).toBe(true);
            return candidate!;
        });
        expect(harness.oldRelease).not.toHaveBeenCalled();
        expect(harness.presentation.pageStates.get(1)?.lease?.surface).toBe(harness.oldLease.surface);
        Object.defineProperties(replacementImage, {
            complete: {
                configurable: true,
                value: true,
            },
            naturalWidth: {
                configurable: true,
                value: 200,
            },
        });
        resolveDecode();
        await restore;

        expect(harness.oldRelease).toHaveBeenCalledOnce();
        expect(harness.presentation.pageStates.get(1)?.lease?.surface).toBe(replacementLease.surface);
        expect(replacementImage.isConnected).toBe(true);
        expect(harness.presentation.getVisual(1)).toBe('fresh');
        expect(harness.renderMountedPages).toHaveBeenCalledOnce();
    });

    it('ignores an old lease invalidation during the replacement commit window', async () => {
        const harness = createPresentationHarness();
        const renderPage = vi.mocked(harness.source.renderPage);
        renderPage.mockResolvedValueOnce(harness.oldLease);
        harness.presentation.beginSourceGeneration();
        harness.oldRelease.mockClear();

        await harness.presentation.renderPage(1);
        harness.image.dataset.pageRenderGeneration = '2';
        await harness.presentation.handleSurfaceLoad(
            1,
            'old-surface',
            createCurrentTargetEvent(harness.image),
        );
        expect(harness.presentation.pageStates.get(1)?.ready).toBe(true);

        let resolveDecode!: () => void;
        vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(() => new Promise((resolve) => {
            resolveDecode = resolve;
        }));
        const replacementUnsubscribe = vi.fn();
        const replacementRelease = vi.fn();
        const replacementLease: IDocumentSurfaceLease = {
            bytes: 360_000,
            heightPx: 300,
            onInvalidated: vi.fn(() => {
                harness.invalidateOldLease();
                return replacementUnsubscribe;
            }),
            release: replacementRelease,
            surface: 'replacement-surface',
            widthPx: 300,
        };
        harness.setPageScale(3);
        const replacementRender = harness.presentation.renderPage(1);
        await vi.waitFor(() => expect(renderPage).toHaveBeenCalledTimes(2));
        harness.resolveReplacement(replacementLease);
        const replacementImage = await vi.waitFor(() => {
            const candidate = harness.page.querySelector<HTMLImageElement>(
                '[data-page-source-candidate]',
            );
            expect(candidate?.dataset.pageRenderGeneration).toBe('3');
            return candidate!;
        });
        Object.defineProperties(replacementImage, {
            complete: {
                configurable: true,
                value: true,
            },
            naturalWidth: {
                configurable: true,
                value: 300,
            },
        });
        resolveDecode();
        await replacementRender;

        const state = harness.presentation.pageStates.get(1);
        expect(state?.lease).toBe(replacementLease);
        expect(state?.ready).toBe(true);
        expect(replacementImage.isConnected).toBe(true);
        expect(harness.oldUnsubscribeInvalidation).toHaveBeenCalledOnce();
        expect(harness.oldRelease).toHaveBeenCalledOnce();
        expect(replacementRelease).not.toHaveBeenCalled();
        expect(replacementUnsubscribe).not.toHaveBeenCalled();
    });

    it('exhausts render failures without resetting or rescheduling terminal work', async () => {
        const harness = createPresentationHarness();
        const render = vi.mocked(harness.source.renderPage);
        const receipt: FailureReceipt = {
            code: 'UNCLASSIFIED_RENDERER_ERROR',
            eventId: createDiagnosticEventId(),
            occurredAt: requireEpochMs(1),
            severity: 'error',
        };
        const capture = vi.spyOn(BrowserLogger, 'error').mockReturnValue(receipt);
        render.mockRejectedValue(new Error('render failed'));
        harness.presentation.beginSourceGeneration();

        await harness.presentation.renderPage(1);
        expect(harness.presentation.pageStates.get(1)?.retryCount).toBe(1);
        await harness.presentation.renderPage(1);
        expect(harness.presentation.pageStates.get(1)?.retryCount).toBe(2);
        await harness.presentation.renderPage(1);
        expect(harness.presentation.pageStates.get(1)?.error).toBe('Unable to display page 1');
        expect(render).toHaveBeenCalledTimes(3);
        expect(capture).toHaveBeenCalledOnce();
        expect(harness.presentation.getVisualFailurePresentation(1)?.failure).toBe(receipt);

        await harness.presentation.renderPage(1);
        expect(render).toHaveBeenCalledTimes(3);
        expect(capture).toHaveBeenCalledOnce();
        expect(harness.emit).toHaveBeenCalledWith('loadError', expect.any(Error));
    });

    it('persists image-error retries until exhaustion and clears them with the source generation', async () => {
        const harness = createPresentationHarness();
        vi.spyOn(HTMLImageElement.prototype, 'decode').mockResolvedValue();
        vi.mocked(harness.source.renderPage)
            .mockResolvedValueOnce({
                bytes: 40_000,
                heightPx: 100,
                release: vi.fn(),
                surface: 'retry-surface-1',
                widthPx: 200,
            })
            .mockResolvedValueOnce({
                bytes: 40_000,
                heightPx: 100,
                release: vi.fn(),
                surface: 'retry-surface-2',
                widthPx: 200,
            });
        harness.image.dataset.openSurfaceGeneration = '';

        harness.presentation.handleSurfaceError(
            1,
            'old-surface',
            createCurrentTargetEvent(harness.image),
        );
        await vi.waitFor(() => expect(harness.presentation.pageStates.get(1)?.lease?.surface)
            .toBe('retry-surface-1'));
        expect(harness.presentation.pageStates.get(1)?.retryCount).toBe(1);

        harness.image.dataset.pageRenderGeneration = '2';
        harness.presentation.handleSurfaceError(
            1,
            'retry-surface-1',
            createCurrentTargetEvent(harness.image),
        );
        await vi.waitFor(() => expect(harness.presentation.pageStates.get(1)?.lease?.surface)
            .toBe('retry-surface-2'));
        expect(harness.presentation.pageStates.get(1)?.retryCount).toBe(2);

        harness.image.dataset.pageRenderGeneration = '3';
        harness.presentation.handleSurfaceError(
            1,
            'retry-surface-2',
            createCurrentTargetEvent(harness.image),
        );
        expect(harness.presentation.pageStates.get(1)?.error).toBe('Unable to display page 1');
        expect(harness.source.renderPage).toHaveBeenCalledTimes(2);

        harness.presentation.beginSourceGeneration();
        expect(harness.presentation.pageStates.get(1)).toBeUndefined();
    });

    it('resets retry exhaustion only when a surface becomes ready', async () => {
        const harness = createPresentationHarness();
        const state = harness.presentation.pageStates.get(1)!;
        state.retryCount = 2;

        await harness.presentation.handleSurfaceLoad(
            1,
            'old-surface',
            createCurrentTargetEvent(harness.image),
        );

        expect(state.ready).toBe(true);
        expect(state.retryCount).toBe(0);
    });

    it('ignores a stale failed attempt after a source generation reset', async () => {
        const harness = createPresentationHarness();
        harness.presentation.beginSourceGeneration();
        let rejectRender!: (error: Error) => void;
        vi.mocked(harness.source.renderPage).mockImplementation(() => new Promise((
            _resolve,
            reject,
        ) => {
            rejectRender = reject;
        }));
        const render = harness.presentation.renderPage(1);
        await vi.waitFor(() => expect(harness.source.renderPage).toHaveBeenCalledOnce());

        harness.presentation.beginSourceGeneration();
        rejectRender(new Error('stale render failure'));
        await render;

        expect(harness.presentation.pageStates.get(1)).toBeUndefined();
        expect(harness.emit).not.toHaveBeenCalledWith('loadError', expect.anything());
    });
});
