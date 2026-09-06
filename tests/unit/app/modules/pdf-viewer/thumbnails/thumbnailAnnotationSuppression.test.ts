import type {
    IPdfDocument,
    IPdfPage,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
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
    computed,
    createApp,
    defineComponent,
    h,
    nextTick,
    ref,
} from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { cast } from '@tests/helpers/cast';

const ANNOTATION_MODE = {
    DISABLE: 0,
    ENABLE: 1,
    ENABLE_FORMS: 2,
    ENABLE_STORAGE: 3,
};

vi.mock('@app/services/pdfjs/runtimeLib', () => ({AnnotationMode: ANNOTATION_MODE}));

// The runtime only reaches the document source to preload an aspect ratio, which
// this harness supplies up front; the scheduler leases its pages directly.
vi.mock('@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource', () => ({leasePdfDocumentPage: async (
    _pdfDocument: unknown,
    pageNumber: number,
) => ({
    page: createPdfPage(pageNumber),
    release: () => {},
})}));

const { createPdfPageRasterScheduler } = await import(
    '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler'
);
const { resetCoordinatedPdfPageRendersForTest } = await import(
    '@app/modules/pdf-viewer/engine/pdf-page-render-coordinator/coordinatedPdfPageRender'
);
const { usePdfThumbnailRenderRuntime } = await import(
    '@app/modules/pdf-viewer/thumbnails/usePdfThumbnailRenderRuntime'
);

const TOTAL_PAGES = 3;
const MOUNTED_PAGES = [
    1,
    2,
    3,
];
const DOCUMENT_FENCE = {
    documentRevision: null,
    documentVersion: 1,
    loadToken: 1,
};

interface IRecordedRender {
    pageNumber: number;
    annotationMode: number;
    hasOperationsFilter: boolean;
    keptAnnotationIds: string[];
}

const renders: IRecordedRender[] = [];
let renderCompletion = () => Promise.resolve();

function createOperatorList(pageNumber: number) {
    // Each page paints one content operator plus one annotation bracket, so a
    // suppressed annotation is observable as a missing id in the kept output.
    return {
        fnArray: [
            10,
            80,
            20,
            81,
        ],
        argsArray: [
            [],
            [`${String(pageNumber)}0R`],
            [],
            [],
        ],
    };
}

function createPdfPage(pageNumber: number) {
    return cast<IPdfPage>({
        pageNumber,
        getViewport: ({scale = 1}: {scale?: number} = {}) => ({
            width: 100 * scale,
            height: 140 * scale,
        }),
        render: (options: Record<string, unknown>) => {
            const operatorList = createOperatorList(pageNumber);
            const operationsFilter = options.operationsFilter as ((index: number) => boolean) | undefined;
            // pdf.js walks the operator list after the caller has bound the task,
            // so defer the filter to the microtask that follows page.render().
            queueMicrotask(() => {
                const keptAnnotationIds: string[] = [];
                for (let index = 0; index < operatorList.fnArray.length; index += 1) {
                    if (operationsFilter && !operationsFilter(index)) {
                        continue;
                    }
                    const args = operatorList.argsArray[index];
                    if (
                        operatorList.fnArray[index] === 80
                        && Array.isArray(args)
                        && typeof args[0] === 'string'
                    ) {
                        keptAnnotationIds.push(args[0]);
                    }
                }
                renders.push({
                    pageNumber,
                    annotationMode: Number(options.annotationMode),
                    hasOperationsFilter: Boolean(operationsFilter),
                    keptAnnotationIds,
                });
            });
            return {
                _internalRenderTask: {operatorList},
                cancel: () => {},
                promise: renderCompletion(),
            };
        },
    });
}

function createContext() {
    return new Proxy({} as Record<string | symbol, unknown>, {
        get: (target, property) => {
            if (!(property in target)) {
                target[property] = vi.fn();
            }
            return target[property];
        },
        set: () => true,
    });
}

function createCanvas() {
    const canvas = document.createElement('canvas');
    canvas.getContext = cast<HTMLCanvasElement['getContext']>(() => createContext());
    return canvas;
}

function createComment(overrides: Partial<IAnnotationCommentSummary>): IAnnotationCommentSummary {
    return {
        id: '10R0',
        stableKey: 'ann:0:10R',
        pageIndex: 0,
        pageNumber: 1,
        text: 'Marked text',
        kindLabel: null,
        subtype: 'Highlight',
        author: null,
        modifiedAt: null,
        color: '#22c55e',
        colorEdited: true,
        uid: null,
        annotationId: '10R0',
        source: 'pdf',
        markerRect: {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.04,
        },
        ...overrides,
    };
}

function mountThumbnailRuntime(annotationComments: ReturnType<typeof ref<IAnnotationCommentSummary[]>>) {
    const canvases = new Map(MOUNTED_PAGES.map(page => [
        page,
        createCanvas(),
    ]));
    const container = document.createElement('div');
    document.body.append(container);
    const scheduler = createPdfPageRasterScheduler({
        documentFence: DOCUMENT_FENCE,
        leasePage: async (pageNumber: number) => ({
            page: createPdfPage(pageNumber),
            release: () => {},
        }),
        maxConcurrency: MOUNTED_PAGES.length,
    });
    const invalidationRequest = ref<{
        id: number;
        pages: number[];
    } | null>(null);

    const host = defineComponent({setup() {
        usePdfThumbnailRenderRuntime({
            dom: {
                getCanvas: page => canvases.get(page) ?? null,
                resolveVisibleContainer: () => container,
            },
            effects: {
                cancelActivePaneRefresh: () => {},
                measureThumbnailHeight: () => {},
                onSourceCycleStarted: () => {},
                refreshVisibleThumbnailPane: () => {},
                resetMeasurementState: () => {},
                scheduleActivePaneRefresh: () => {},
            },
            layout: {
                clearThumbnailAspectRatios: () => {},
                resolveViewportAnchorPage: () => 1,
                shouldPreferVisibleAnchorOverCurrentPage: () => false,
                thumbnailAspectRatios: ref(new Map([
                    [
                        1,
                        1.4,
                    ],
                    [
                        2,
                        1.4,
                    ],
                    [
                        3,
                        1.4,
                    ],
                ])),
                thumbnailLayoutWidth: ref(128),
                thumbnailRenderWidth: ref(128),
                updateThumbnailAspectRatio: () => {},
                viewportPages: computed(() => MOUNTED_PAGES),
                virtualPages: computed(() => MOUNTED_PAGES),
            },
            source: {
                currentPage: computed(() => 1),
                invalidationRequest: computed(() => invalidationRequest.value),
                isActive: computed(() => true),
                pdfDocument: computed(() => cast<IPdfDocument>({numPages: TOTAL_PAGES})),
                rasterScheduler: computed(() => scheduler),
                totalPages: computed(() => TOTAL_PAGES),
            },
            visuals: {
                annotationComments: computed(() => annotationComments.value ?? []),
                annotationSettings: computed(() => null),
                hiddenAnnotationIds: computed(() => []),
            },
        });
        return () => h('div');
    }});

    const app = createApp(host);
    app.mount(container);
    return {
        canvases,
        invalidationRequest,
        unmount: async () => {
            app.unmount();
            await scheduler.dispose();
            container.remove();
        },
    };
}

async function settleRenders() {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        await vi.advanceTimersByTimeAsync(20);
    }
}

describe('thumbnail annotation suppression', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
            cast<HTMLCanvasElement['getContext']>(() => createContext()),
        );
        renders.length = 0;
        renderCompletion = () => Promise.resolve();
        resetCoordinatedPdfPageRendersForTest();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        resetCoordinatedPdfPageRendersForTest();
        document.body.innerHTML = '';
    });

    it('renders each page once and keeps annotations on pages with nothing to suppress', async () => {
        const annotationComments = ref<IAnnotationCommentSummary[]>([createComment({
            annotationId: '20R0',
            id: '20R0',
            stableKey: 'ann:1:20R',
            pageIndex: 1,
            pageNumber: 2,
        })]);
        const {unmount} = mountThumbnailRuntime(annotationComments);

        try {
            await settleRenders();

            expect(renders.map(render => render.pageNumber).sort()).toEqual(MOUNTED_PAGES);
            expect(renders.filter(render => render.annotationMode === ANNOTATION_MODE.DISABLE)).toEqual([]);
            expect(renders.find(render => render.pageNumber === 1)?.keptAnnotationIds).toEqual(['10R']);
            expect(renders.find(render => render.pageNumber === 3)?.keptAnnotationIds).toEqual(['30R']);
            expect(renders.find(render => render.pageNumber === 1)?.hasOperationsFilter).toBe(false);
        } finally {
            await unmount();
        }
    });

    it('re-renders only the recoloured page when a highlight colour changes', async () => {
        const annotationComments = ref<IAnnotationCommentSummary[]>([createComment({
            annotationId: '20R0',
            id: '20R0',
            stableKey: 'ann:1:20R',
            pageIndex: 1,
            pageNumber: 2,
        })]);
        const {unmount} = mountThumbnailRuntime(annotationComments);

        try {
            await settleRenders();
            renders.length = 0;

            annotationComments.value = [createComment({
                annotationId: '20R0',
                color: '#ef4444',
                id: '20R0',
                stableKey: 'ann:1:20R',
                pageIndex: 1,
                pageNumber: 2,
            })];
            await settleRenders();

            expect(renders.map(render => render.pageNumber)).toEqual([2]);
        } finally {
            await unmount();
        }
    });

    it('keeps the painted thumbnail visible while an edited page is invalidated', async () => {
        const annotationComments = ref<IAnnotationCommentSummary[]>([]);
        const {
            canvases,
            invalidationRequest,
            unmount,
        } = mountThumbnailRuntime(annotationComments);

        let finishReplacementRender = () => {};
        let markReplacementStarted = () => {};
        let replacementRenderSettled = false;
        const replacementStarted = new Promise<void>((resolve) => {
            markReplacementStarted = resolve;
        });
        const replacementRender = new Promise<void>((resolve) => {
            finishReplacementRender = resolve;
        });
        try {
            await settleRenders();
            const canvas = canvases.get(1);
            expect(canvas?.dataset.thumbnailRendered).toBe('true');
            expect(canvas?.width).toBeGreaterThan(0);

            renderCompletion = () => {
                markReplacementStarted();
                return replacementRender.then(() => {
                    replacementRenderSettled = true;
                });
            };
            renders.length = 0;
            invalidationRequest.value = {
                id: 1,
                pages: [1],
            };
            await nextTick();

            expect(canvas?.dataset.thumbnailPreservedBitmap).toBe('true');
            expect(canvas?.width).toBeGreaterThan(0);
            await vi.advanceTimersByTimeAsync(20);
            await replacementStarted;
            expect(renders.map(render => render.pageNumber)).toEqual([1]);
            expect(canvas?.dataset.thumbnailPreservedBitmap).toBe('true');
            expect(canvas?.width).toBeGreaterThan(0);

            finishReplacementRender();
            await settleRenders();
            expect(replacementRenderSettled).toBe(true);
            expect(canvas?.dataset.thumbnailRendered).toBe('true');
            expect(canvas?.width).toBeGreaterThan(0);
        } finally {
            finishReplacementRender();
            await unmount();
        }
    });
});
