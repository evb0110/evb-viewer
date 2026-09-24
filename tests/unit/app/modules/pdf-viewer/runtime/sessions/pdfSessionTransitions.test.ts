import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed, ref, 
} from 'vue';
import { requireDocumentRef } from '@contracts/documentRef';
import {
    requireDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import type { IPdfDocumentTransition } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    warnThrottled: vi.fn(),
    debug: vi.fn(),
}}));

class MockPdfDataRangeTransport {
    public onDataRange = vi.fn();
    public abort = vi.fn();

    constructor(length: number, initialData: Uint8Array) {
        void length;
        void initialData;
    }
}

const pdfjsState = {
    version: '6.3.311',
    GlobalWorkerOptions: { workerSrc: '' },
    VerbosityLevel: { ERRORS: 0 },
    getDocument: vi.fn(),
    PDFDataRangeTransport: MockPdfDataRangeTransport,
};

vi.mock('pdfjs-dist', () => pdfjsState);

const electronApi = createElectronPlatformApiFixture({documentFiles: {readFileRange: vi.fn()}});
vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => electronApi}));

const {createPdfDocumentSession} = await import('@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession');

function createDocumentProxy(id: string, numPages = 1) {
    return {
        id,
        numPages,
        getPage: vi.fn(async () => ({
            getViewport: () => ({
                width: 100,
                height: 200,
            }),
            cleanup: vi.fn(),
        })),
        destroy: vi.fn(async () => undefined),
        cleanup: vi.fn(async () => undefined),
    };
}

function createMetricDocumentProxy(
    id: string,
    numPages: number,
    rotatedPage: number | null = null,
    onPageRequested?: (pageNumber: number) => void,
) {
    return {
        ...createDocumentProxy(id),
        numPages,
        getPage: vi.fn(async (pageNumber: number) => {
            onPageRequested?.(pageNumber);
            const isRotated = pageNumber === rotatedPage;
            return {
                getViewport: () => ({
                    width: isRotated ? 200 : 100,
                    height: isRotated ? 100 : 200,
                    rotation: isRotated ? 90 : 0,
                    userUnit: 1,
                }),
                cleanup: vi.fn(),
            };
        }),
    };
}

/** Resolves the PDF.js loading task only when the test asks for it. */
function createDeferredLoadingTask(document: ReturnType<typeof createDocumentProxy>) {
    let resolveTask!: (value: unknown) => void;
    const promise = new Promise((resolve) => {
        resolveTask = resolve;
    });
    return {
        task: {
            promise,
            destroy: vi.fn(async () => undefined),
        },
        settle: () => resolveTask(document),
    };
}

describe('PdfDocumentSession transitions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('URL', {
            ...URL,
            createObjectURL: () => 'blob:pdf',
            revokeObjectURL: () => undefined,
        });
    });

    it('emits loading, ready and settled to subscribers in subscription order', async () => {
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(createDocumentProxy('a')),
            destroy: vi.fn(),
        });
        const source = computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never);
        const session = createPdfDocumentSession({src: source});
        const observed: string[] = [];
        session.subscribe(transition => {
            observed.push(`viewport:${transition.phase}`);
        });
        session.subscribe(transition => {
            observed.push(`rendering:${transition.phase}`);
        });

        await session.load();

        expect(observed).toEqual([
            'viewport:loading',
            'rendering:loading',
            'viewport:ready',
            'rendering:ready',
            'viewport:settled',
            'rendering:settled',
        ]);
    });

    it('publishes the document-owned raster scheduler only after metrics are ready and clears it on cleanup', async () => {
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(createDocumentProxy('scheduler-owner')),
            destroy: vi.fn(),
        });
        const emitRasterScheduler = vi.fn();
        const session = createPdfDocumentSession({
            src: computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never),
            emitRasterScheduler,
        });

        await session.load();

        expect(emitRasterScheduler).toHaveBeenCalledTimes(1);
        expect(emitRasterScheduler).toHaveBeenLastCalledWith(session.rasterScheduler);
        expect(session.rasterScheduler).not.toBeNull();

        session.cleanup();

        expect(emitRasterScheduler).toHaveBeenLastCalledWith(null);
        expect(session.rasterScheduler).toBeNull();
    });

    it('never publishes a live raster scheduler when initial metric priming fails', async () => {
        const document = createDocumentProxy('metric-failure');
        document.getPage.mockRejectedValueOnce(new Error('page one metric failed'));
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(document),
            destroy: vi.fn(),
        });
        const emitRasterScheduler = vi.fn();
        const session = createPdfDocumentSession({
            src: computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never),
            emitRasterScheduler,
        });

        await session.load();

        expect(emitRasterScheduler.mock.calls).toEqual([[null]]);
        expect(session.rasterScheduler).toBeNull();
        expect(session.document.value).toBeNull();
    });

    it('restores a remounted rendering subscriber after its predecessor wedged mid-open', async () => {
        const wedgedDocument = createDocumentProxy('wedged');
        const wedged = createDeferredLoadingTask(wedgedDocument);
        const recoveredDocument = createDocumentProxy('recovered');
        pdfjsState.getDocument
            .mockReturnValueOnce(wedged.task)
            .mockReturnValue({
                promise: Promise.resolve(recoveredDocument),
                destroy: vi.fn(),
            });

        const source = computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never);
        const predecessor = createPdfDocumentSession({src: source});
        const predecessorPhases: IPdfDocumentTransition[] = [];
        predecessor.subscribe(transition => {
            predecessorPhases.push(transition);
        });

        // The predecessor open never resolves: it parks in `loading`.
        const wedgedLoad = predecessor.load();
        await vi.waitFor(() => {
            expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        });
        expect(predecessorPhases.map(phase => phase.phase)).toEqual(['loading']);
        const wedgedFence = predecessorPhases[0]!.fence;
        await predecessor.dispose();

        const active = ref(true);
        const successor = createPdfDocumentSession({
            src: source,
            isActive: computed(() => active.value),
        });
        const viewportPhases: string[] = [];
        const renderingPhases: string[] = [];
        let renderingFence: IPdfDocumentTransition['fence'] | null = null;
        successor.subscribe((transition) => {
            viewportPhases.push(transition.phase);
        });
        successor.subscribe((transition) => {
            renderingPhases.push(transition.phase);
            if (transition.phase === 'ready' || transition.phase === 'restore') {
                renderingFence = transition.fence;
            }
        });

        await successor.load();
        active.value = false;
        await nextTick();
        active.value = true;
        await vi.waitFor(() => {
            expect(renderingPhases.at(-1)).toBe('restore');
        });

        expect(viewportPhases).toEqual(renderingPhases);
        expect(successor.document.value).toBe(recoveredDocument);
        expect(renderingFence).not.toBeNull();
        expect(successor.isCurrent(renderingFence!)).toBe(true);

        // A disposed predecessor resolving afterwards cannot invalidate or
        // tear down the remounted rendering session.
        wedged.settle();
        await wedgedLoad;
        expect(predecessorPhases).toHaveLength(1);
        expect(predecessor.isCurrent(wedgedFence)).toBe(false);
        expect(successor.document.value).toBe(recoveredDocument);
        expect(renderingPhases.at(-1)).toBe('restore');
    });

    it('fences a stale ready transition before a later rendering subscriber can tear down', async () => {
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(createDocumentProxy('a')),
            destroy: vi.fn(),
        });
        const source = computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never);
        const session = createPdfDocumentSession({src: source});
        const renderingPhases: string[] = [];

        session.subscribe(async (transition) => {
            if (transition.phase === 'ready') {
                await session.invalidate('superseded-during-viewport-placement');
            }
        });
        session.subscribe((transition) => {
            renderingPhases.push(transition.phase);
        });

        await session.load();

        expect(renderingPhases).toEqual([
            'loading',
            'invalidated',
        ]);
        expect(renderingPhases).not.toContain('ready');
    });

    it('disposes registered sessions in reverse creation order', async () => {
        const session = createPdfDocumentSession();
        const disposed: string[] = [];
        session.registerDisposable(() => {
            disposed.push('viewport');
        });
        session.registerDisposable(() => {
            disposed.push('rendering');
        });
        session.registerDisposable(() => {
            disposed.push('annotation');
        });

        await session.dispose();
        expect(disposed).toEqual([
            'annotation',
            'rendering',
            'viewport',
        ]);

        // Disposal is idempotent: a second call must not re-run the tree.
        await session.dispose();
        expect(disposed).toHaveLength(3);
    });

    it('marks every fence captured before an invalidation stale', async () => {
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(createDocumentProxy('a')),
            destroy: vi.fn(),
        });
        const source = computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never);
        const session = createPdfDocumentSession({src: source});

        await session.load();
        const fence = session.captureFence();
        expect(session.isCurrent(fence)).toBe(true);

        await session.invalidate('test');
        expect(session.isCurrent(fence)).toBe(false);
    });

    it('carries preserved and selective reload intent through the typed transition', async () => {
        pdfjsState.getDocument.mockImplementation(() => ({
            promise: Promise.resolve(createDocumentProxy(crypto.randomUUID())),
            destroy: vi.fn(),
        }));
        const source = computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never);
        const session = createPdfDocumentSession({src: source});
        const loadingPlans: Array<IPdfDocumentTransition['plan']> = [];
        session.subscribe((transition) => {
            if (transition.phase === 'loading') {
                loadingPlans.push(transition.plan);
            }
        });

        await session.load();
        session.preserveNextReloadVisibleContent(true);
        await session.load(true);
        session.preserveNextReloadVisibleContent(true);
        session.invalidatePagesOnNextReload([
            2,
            4,
        ]);
        await session.load(true);

        expect(loadingPlans).toEqual([
            expect.objectContaining({
                isReload: false,
                preserveVisibleContent: false,
                isSelectiveReload: false,
            }),
            expect.objectContaining({
                isReload: true,
                preserveVisibleContent: true,
                preservePageStructure: true,
                isSelectiveReload: false,
            }),
            expect.objectContaining({
                isReload: true,
                preserveVisibleContent: true,
                preservePageStructure: true,
                isSelectiveReload: true,
                pagesToInvalidate: [
                    2,
                    4,
                ],
            }),
        ]);
    });

    it('preserves visible content when a page-mutation revision swap is staged', async () => {
        const previousRevision = requireDocumentRevisionToken('drt1:before-rotate');
        const nextRevision = requireDocumentRevisionToken('drt1:after-rotate');
        const documentRevisionToken = ref(previousRevision);
        const pageSource = ref<unknown>(null);
        const surfaceSnapshot = ref({
            generation: 7,
            phase: 'ready',
            identity: {
                documentId: 'scan.pdf',
                documentRevision: previousRevision,
            },
        });
        const surface = {
            snapshot: surfaceSnapshot,
            prepareRevisionSwap: vi.fn((identity: {
                documentId: string;
                documentRevision: TDocumentRevisionToken
            }) => {
                surfaceSnapshot.value = {
                    ...surfaceSnapshot.value,
                    identity,
                };
                return true;
            }),
            completeRevisionSwap: vi.fn(() => true),
            cancelRevisionSwap: vi.fn(() => true),
            acquireSource: vi.fn(() => 7),
        };
        const chassisAuthority = {
            openSurface: surface,
            source: pageSource,
            bindSource: vi.fn((source: unknown) => {
                pageSource.value = source;
            }),
            surfaceBudget: undefined,
        };
        const source = computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never);
        const emitInitialVisualPending = vi.fn();
        const session = createPdfDocumentSession({
            src: source,
            documentRevisionToken: computed(() => documentRevisionToken.value),
            chassisAuthority: chassisAuthority as never,
            emitInitialVisualPending,
        });
        const loadingPlans: Array<IPdfDocumentTransition['plan']> = [];
        session.subscribe((transition) => {
            if (transition.phase === 'loading') {
                loadingPlans.push(transition.plan);
            }
        });

        pdfjsState.getDocument.mockImplementation(() => ({
            promise: Promise.resolve(createDocumentProxy(crypto.randomUUID(), 200)),
            destroy: vi.fn(),
        }));
        await session.load();
        expect(session.preparePageMutationRevisionSwap(String(nextRevision), [135], 135)).toBe(true);

        documentRevisionToken.value = nextRevision;
        await session.load(true);

        expect(loadingPlans.at(-1)).toMatchObject({
            isReload: true,
            isSelectiveReload: true,
            pagesToInvalidate: [135],
            preserveVisibleContent: true,
            preservePageStructure: true,
        });
        expect(surface.prepareRevisionSwap).toHaveBeenCalledWith({
            documentId: 'scan.pdf',
            documentRevision: nextRevision,
        }, 135, [135]);
        expect(surface.completeRevisionSwap).toHaveBeenCalledWith(7, String(nextRevision));
        expect(emitInitialVisualPending).toHaveBeenCalledOnce();
        await session.dispose();
    });

    it('derives rotation-only geometry from cached metrics and skips replacement page measurement', async () => {
        const previousRevision = requireDocumentRevisionToken('drt1:before-fast-rotate');
        const nextRevision = requireDocumentRevisionToken('drt1:after-fast-rotate');
        const documentRevisionToken = ref(previousRevision);
        const surfaceSnapshot = ref({
            generation: 7,
            phase: 'ready',
            identity: {
                documentId: 'scan.pdf',
                documentRevision: previousRevision,
            },
        });
        const surface = {
            snapshot: surfaceSnapshot,
            prepareRevisionSwap: vi.fn((identity: {
                documentId: string;
                documentRevision: TDocumentRevisionToken
            }) => {
                surfaceSnapshot.value = {
                    ...surfaceSnapshot.value,
                    identity,
                };
                return true;
            }),
            completeRevisionSwap: vi.fn(() => true),
            cancelRevisionSwap: vi.fn(() => true),
            acquireSource: vi.fn(() => 7),
        };
        const replacementPageRequests: number[] = [];
        const previousDocument = createMetricDocumentProxy('before-fast-rotate', 3);
        const replacementDocument = createMetricDocumentProxy(
            'after-fast-rotate',
            3,
            2,
            pageNumber => replacementPageRequests.push(pageNumber),
        );
        let documentLoadCount = 0;
        pdfjsState.getDocument.mockImplementation(() => ({
            promise: Promise.resolve(documentLoadCount++ === 0 ? previousDocument : replacementDocument),
            destroy: vi.fn(),
        }));
        const source = computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never);
        const sourceRef = ref<unknown>(null);
        const session = createPdfDocumentSession({
            src: source,
            documentRevisionToken: computed(() => documentRevisionToken.value),
            chassisAuthority: {
                openSurface: surface,
                source: sourceRef,
                bindSource: vi.fn((pageSource: unknown) => {
                    sourceRef.value = pageSource;
                }),
                surfaceBudget: undefined,
            } as never,
        });
        const loadingPlans: Array<IPdfDocumentTransition['plan']> = [];
        session.subscribe((transition) => {
            if (transition.phase === 'loading' && transition.plan.isSelectiveReload) {
                loadingPlans.push(transition.plan);
            }
        });

        await session.load();
        await session.ensurePageMetricsInRange(1, 3);
        expect(session.pageMetrics.value[1]).toMatchObject({
            width: 100,
            height: 200,
            rotation: 0,
        });
        replacementPageRequests.length = 0;

        expect(session.beginPageMutationRotationPreview([2], 90)).toBe(true);
        expect(session.pageMetrics.value[1]).toMatchObject({
            width: 200,
            height: 100,
            rotation: 90,
        });
        expect(session.cancelPageMutationRotationPreview()).toBe(true);
        expect(session.pageMetrics.value[1]).toMatchObject({
            width: 100,
            height: 200,
            rotation: 0,
        });

        expect(session.beginPageMutationRotationPreview([2], 90)).toBe(true);
        expect(session.preparePageMutationRevisionSwap(
            String(nextRevision),
            [2],
            2,
            90,
        )).toBe(true);
        expect(session.pageMetrics.value[1]).toMatchObject({
            width: 200,
            height: 100,
            rotation: 90,
        });
        expect(session.document.value).toBe(previousDocument);
        expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        documentRevisionToken.value = nextRevision;
        await session.load(true);

        expect(session.document.value).toBe(replacementDocument);
        expect(pdfjsState.getDocument).toHaveBeenCalledTimes(2);
        expect(loadingPlans.at(-1)).toMatchObject({
            rotationDelta: 90,
            preservePageMetrics: true,
        });
        expect(replacementPageRequests).toEqual([]);
        expect(session.pageMetrics.value[1]).toMatchObject({
            width: 200,
            height: 100,
            rotation: 90,
        });
        await session.dispose();
    });

    it('refreshes invalidated page geometry before publishing the selective replacement source', async () => {
        const currentPage = 135;
        const previousDocument = createMetricDocumentProxy('before-rotation', 20_001);
        const replacementPageRequests: number[] = [];
        const replacementDocument = createMetricDocumentProxy(
            'after-rotation',
            20_001,
            currentPage,
            pageNumber => replacementPageRequests.push(pageNumber),
        );
        let documentLoadCount = 0;
        pdfjsState.getDocument.mockImplementation(() => ({
            promise: Promise.resolve(documentLoadCount++ === 0 ? previousDocument : replacementDocument),
            destroy: vi.fn(),
        }));
        const source = computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never);
        const observed: string[] = [];
        let collecting = false;
        const session = createPdfDocumentSession({
            src: source,
            emitDocument: () => {
                if (collecting) observed.push('replacement-source-published');
            },
        });

        await session.load();
        await session.ensurePageMetricsInRange(currentPage, currentPage);
        expect(session.pageMetrics.value[currentPage - 1]).toMatchObject({
            width: 100,
            height: 200,
            rotation: 0,
        });

        session.subscribe(async transition => {
            if (transition.phase !== 'ready' || !transition.plan.isSelectiveReload) return;
            expect(transition.plan.pagesToInvalidate).toEqual([currentPage]);
            await session.ensurePageMetricsInRange(
                currentPage,
                currentPage,
            );
            expect(replacementPageRequests).toContain(currentPage);
            expect(session.pageMetrics.value[currentPage - 1]).toMatchObject({
                width: 200,
                height: 100,
                rotation: 90,
            });
            observed.push('replacement-geometry-ready');
        });
        collecting = true;
        session.preserveNextReloadVisibleContent(true);
        session.invalidatePagesOnNextReload([currentPage]);
        await session.load(true);

        expect(observed).toEqual([
            'replacement-geometry-ready',
            'replacement-source-published',
        ]);
        expect(session.document.value).toBe(replacementDocument);
        expect(pdfjsState.getDocument).toHaveBeenCalledTimes(2);
        await session.dispose();
    });

    it('opens a source that arrives while inactive without parking on activation', async () => {
        const recoveredDocument = createDocumentProxy('warm');
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(recoveredDocument),
            destroy: vi.fn(),
        });
        const source = ref<Blob | null>(null);
        const active = ref(false);
        const session = createPdfDocumentSession({
            src: computed(() => source.value as never),
            isActive: computed(() => active.value),
        });
        const phases: string[] = [];
        session.subscribe((transition) => {
            phases.push(transition.phase);
        });

        source.value = new Blob(['pdf'], {type: 'application/pdf'});

        await vi.waitFor(() => {
            expect(session.document.value).toBe(recoveredDocument);
        });
        expect(active.value).toBe(false);
        expect(phases.slice(-3)).toEqual([
            'loading',
            'ready',
            'settled',
        ]);
    });

    it('starts a replacement from the source watcher while the previous load is unresolved', async () => {
        const sourceA = new Blob(['a'], {type: 'application/pdf'});
        const sourceB = new Blob(['b'], {type: 'application/pdf'});
        const pendingA = createDeferredLoadingTask(createDocumentProxy('a'));
        const documentB = createDocumentProxy('b');
        pdfjsState.getDocument
            .mockReturnValueOnce(pendingA.task)
            .mockReturnValueOnce({
                promise: Promise.resolve(documentB),
                destroy: vi.fn(async () => undefined),
            });
        const source = ref<Blob | null>(sourceA);
        const session = createPdfDocumentSession({src: computed(() => source.value as never)});

        session.scheduleLoad();
        await vi.waitFor(() => {
            expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        });

        source.value = sourceB;

        await vi.waitFor(() => {
            expect(pdfjsState.getDocument).toHaveBeenCalledTimes(2);
        });

        expect(session.document.value).toBe(documentB);
        pendingA.settle();
        await session.dispose();
    });

    it('treats a changed path revision as a new document load', async () => {
        electronApi.documentFiles.readFileRange.mockResolvedValue(Uint8Array.of(1, 2, 3, 4));
        pdfjsState.getDocument
            .mockReturnValueOnce({
                promise: Promise.resolve(createDocumentProxy('revision-a')),
                destroy: vi.fn(async () => undefined),
            })
            .mockReturnValueOnce({
                promise: Promise.resolve(createDocumentProxy('revision-b')),
                destroy: vi.fn(async () => undefined),
            });
        const source = ref({
            kind: 'path' as const,
            path: requireDocumentRef('/tmp/revisioned.pdf'),
            size: 2048,
            revision: 'revision-a',
        });
        const loadingTransitions: IPdfDocumentTransition[] = [];
        const session = createPdfDocumentSession({src: computed(() => source.value as never)});
        session.subscribe((transition) => {
            if (transition.phase === 'loading') {
                loadingTransitions.push(transition);
            }
        });

        await session.load();
        source.value = {
            ...source.value,
            revision: 'revision-b',
        };

        await vi.waitFor(() => {
            expect(pdfjsState.getDocument).toHaveBeenCalledTimes(2);
        });

        expect(loadingTransitions.at(-1)?.isSameDocumentRewrite).toBe(false);
        expect(session.document.value).toMatchObject({id: 'revision-b'});
        await session.dispose();
    });

    it('clears a pending source without waiting for its loader to resolve', async () => {
        const pendingA = createDeferredLoadingTask(createDocumentProxy('a'));
        pdfjsState.getDocument.mockReturnValueOnce(pendingA.task);
        const source = ref<Blob | null>(new Blob(['a'], {type: 'application/pdf'}));
        const emitDocument = vi.fn();
        const session = createPdfDocumentSession({
            src: computed(() => source.value as never),
            emitDocument,
        });

        session.scheduleLoad();
        await vi.waitFor(() => {
            expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        });

        source.value = null;

        await vi.waitFor(() => {
            expect(pendingA.task.destroy).toHaveBeenCalledOnce();
        });
        expect(session.document.value).toBeNull();
        expect(session.loadState.value.status).toBe('idle');
        expect(emitDocument).toHaveBeenLastCalledWith(null);

        pendingA.settle();
        await session.dispose();
    });

    it('suppresses a superseded load rejection but emits the current load failure', async () => {
        const staleLoad = Promise.withResolvers<ReturnType<typeof createDocumentProxy>>();
        const currentFailure = new Error('current PDF parse failed');
        pdfjsState.getDocument
            .mockReturnValueOnce({
                promise: staleLoad.promise,
                destroy: vi.fn(async () => undefined),
            })
            .mockReturnValueOnce({
                promise: Promise.resolve(createDocumentProxy('replacement')),
                destroy: vi.fn(async () => undefined),
            })
            .mockImplementationOnce(() => ({
                promise: Promise.reject(currentFailure),
                destroy: vi.fn(async () => undefined),
            }));
        const source = computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never);
        const emitLoadError = vi.fn();
        const session = createPdfDocumentSession({
            src: source,
            emitLoadError,
        });

        const superseded = session.load();
        await vi.waitFor(() => {
            expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        });
        await session.load();
        staleLoad.reject(new Error('superseded PDF parse failed'));
        await superseded;

        expect(session.document.value).toMatchObject({id: 'replacement'});
        expect(emitLoadError).not.toHaveBeenCalled();

        await session.load();

        expect(emitLoadError).toHaveBeenCalledExactlyOnceWith(currentFailure);
        expect(session.loadError.value).toBe(currentFailure);
    });
});
