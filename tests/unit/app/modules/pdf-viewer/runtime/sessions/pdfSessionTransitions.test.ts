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
        loadingTask: {destroy: vi.fn(async () => undefined)},
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
        const view = session.attachView();
        const observed: string[] = [];
        view.subscribe(transition => {
            observed.push(`viewport:${transition.phase}`);
        });
        view.subscribe(transition => {
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

    it('owns a raster scheduler once metrics are ready and clears it on cleanup', async () => {
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(createDocumentProxy('scheduler-owner')),
            destroy: vi.fn(),
        });
        const session = createPdfDocumentSession({src: computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never)});

        await session.load();

        expect(session.rasterScheduler).not.toBeNull();

        session.cleanup();

        expect(session.rasterScheduler).toBeNull();
    });

    it('keeps no raster scheduler when initial metric priming fails', async () => {
        const document = createDocumentProxy('metric-failure');
        document.getPage.mockRejectedValueOnce(new Error('page one metric failed'));
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(document),
            destroy: vi.fn(),
        });
        const session = createPdfDocumentSession({src: computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never)});

        await session.load();

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
        const predecessorView = predecessor.attachView();
        const predecessorPhases: IPdfDocumentTransition[] = [];
        predecessorView.subscribe(transition => {
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
        const successor = createPdfDocumentSession({src: source});
        const successorView = successor.attachView({isActive: computed(() => active.value)});
        const viewportPhases: string[] = [];
        const renderingPhases: string[] = [];
        let renderingFence: IPdfDocumentTransition['fence'] | null = null;
        successorView.subscribe((transition) => {
            viewportPhases.push(transition.phase);
        });
        successorView.subscribe((transition) => {
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
        expect(successorView.isCurrent(renderingFence!)).toBe(true);

        // A disposed predecessor resolving afterwards cannot invalidate or
        // tear down the remounted rendering session.
        wedged.settle();
        await wedgedLoad;
        expect(predecessorPhases).toHaveLength(1);
        expect(predecessorView.isCurrent(wedgedFence)).toBe(false);
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
        const view = session.attachView();
        const renderingPhases: string[] = [];

        view.subscribe(async (transition) => {
            if (transition.phase === 'ready') {
                await session.invalidate('superseded-during-viewport-placement');
            }
        });
        view.subscribe((transition) => {
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
        const view = session.attachView();
        const disposed: string[] = [];
        view.registerDisposable(() => {
            disposed.push('viewport');
        });
        view.registerDisposable(() => {
            disposed.push('rendering');
        });
        view.registerDisposable(() => {
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
        const view = session.attachView();

        await session.load();
        const fence = view.captureFence();
        expect(view.isCurrent(fence)).toBe(true);

        await session.invalidate('test');
        expect(view.isCurrent(fence)).toBe(false);
    });

    it('carries preserved and selective reload intent through the typed transition', async () => {
        pdfjsState.getDocument.mockImplementation(() => ({
            promise: Promise.resolve(createDocumentProxy(crypto.randomUUID())),
            destroy: vi.fn(),
        }));
        const source = computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never);
        const session = createPdfDocumentSession({src: source});
        const view = session.attachView();
        const loadingPlans: Array<IPdfDocumentTransition['plan']> = [];
        view.subscribe((transition) => {
            if (transition.phase === 'loading') {
                loadingPlans.push(transition.plan);
            }
        });

        await session.load();
        view.preserveNextReloadVisibleContent(true);
        await session.load(true);
        view.preserveNextReloadVisibleContent(true);
        view.invalidatePagesOnNextReload([
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
        });
        const view = session.attachView({
            chassisAuthority: chassisAuthority as never,
            emitInitialVisualPending,
        });
        const loadingPlans: Array<IPdfDocumentTransition['plan']> = [];
        view.subscribe((transition) => {
            if (transition.phase === 'loading') {
                loadingPlans.push(transition.plan);
            }
        });

        pdfjsState.getDocument.mockImplementation(() => ({
            promise: Promise.resolve(createDocumentProxy(crypto.randomUUID(), 200)),
            destroy: vi.fn(),
        }));
        await session.load();
        expect(view.preparePageMutationRevisionSwap(String(nextRevision), [135], 135)).toBe(true);

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
        });
        const view = session.attachView({chassisAuthority: {
            openSurface: surface,
            source: sourceRef,
            bindSource: vi.fn((pageSource: unknown) => {
                sourceRef.value = pageSource;
            }),
            surfaceBudget: undefined,
        } as never});
        const loadingPlans: Array<IPdfDocumentTransition['plan']> = [];
        view.subscribe((transition) => {
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
        expect(view.preparePageMutationRevisionSwap(
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
        const session = createPdfDocumentSession({src: source});
        const view = session.attachView({emitDocument: () => {
            if (collecting) observed.push('replacement-source-published');
        }});

        await session.load();
        await session.ensurePageMetricsInRange(currentPage, currentPage);
        expect(session.pageMetrics.value[currentPage - 1]).toMatchObject({
            width: 100,
            height: 200,
            rotation: 0,
        });

        view.subscribe(async transition => {
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
        view.preserveNextReloadVisibleContent(true);
        view.invalidatePagesOnNextReload([currentPage]);
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
        const session = createPdfDocumentSession({src: computed(() => source.value as never)});
        const view = session.attachView({isActive: computed(() => active.value)});
        const phases: string[] = [];
        view.subscribe((transition) => {
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
        session.attachView();

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
        session.attachView().subscribe((transition) => {
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
        const session = createPdfDocumentSession({src: computed(() => source.value as never)});
        session.attachView({emitDocument});

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
        const session = createPdfDocumentSession({src: source});
        session.attachView({emitLoadError});

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

describe('PdfDocumentSession linked views', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('URL', {
            ...URL,
            createObjectURL: () => 'blob:pdf',
            revokeObjectURL: () => undefined,
        });
    });

    function observe(view: ReturnType<ReturnType<typeof createPdfDocumentSession>['attachView']>) {
        const phases: string[] = [];
        view.subscribe((transition) => {
            phases.push(transition.phase);
        });
        return phases;
    }

    it('opens the PDF once and presents it in every view', async () => {
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(createDocumentProxy('shared')),
            destroy: vi.fn(),
        });
        const session = createPdfDocumentSession({src: computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never)});
        const left = observe(session.attachView());
        const right = observe(session.attachView());

        await session.load();

        expect(pdfjsState.getDocument).toHaveBeenCalledOnce();
        expect(left).toEqual([
            'loading',
            'ready',
            'settled',
        ]);
        expect(right).toEqual([
            'loading',
            'ready',
            'settled',
        ]);
        await session.dispose();
    });

    it('presents an open document to a view attached afterwards as a fresh open', async () => {
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(createDocumentProxy('shared')),
            destroy: vi.fn(),
        });
        const session = createPdfDocumentSession({src: computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never)});
        const source = observe(session.attachView());
        await session.load();
        await session.load(true);
        const sourcePhaseCount = source.length;

        const emitDocument = vi.fn();
        const lateView = session.attachView({emitDocument});
        const plans: Array<IPdfDocumentTransition['plan']> = [];
        lateView.subscribe((transition) => {
            plans.push(transition.plan);
        });
        const late = observe(lateView);
        lateView.present();
        await vi.waitFor(() => expect(late).toEqual([
            'loading',
            'ready',
            'settled',
        ]));

        expect(pdfjsState.getDocument).toHaveBeenCalledTimes(2);
        expect(plans[0]).toMatchObject({
            isReload: false,
            preserveVisibleContent: false,
        });
        expect(emitDocument).toHaveBeenLastCalledWith(session.pdfDocument.value);
        // The view that already shows the document is not reloaded for it.
        expect(source).toHaveLength(sourcePhaseCount);
        await session.dispose();
    });

    it('cancels only the view that stops being active and reclaims caches once none is', async () => {
        const document = createDocumentProxy('shared');
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(document),
            destroy: vi.fn(),
        });
        const leftActive = ref(true);
        const rightActive = ref(true);
        const session = createPdfDocumentSession({src: computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never)});
        const left = observe(session.attachView({isActive: computed(() => leftActive.value)}));
        const right = observe(session.attachView({isActive: computed(() => rightActive.value)}));
        await session.load();

        leftActive.value = false;
        await vi.waitFor(() => expect(left.at(-1)).toBe('invalidated'));
        await Promise.resolve();
        expect(right.at(-1)).toBe('settled');
        expect(document.cleanup).not.toHaveBeenCalled();

        rightActive.value = false;
        await vi.waitFor(() => expect(right.at(-1)).toBe('invalidated'));
        await vi.waitFor(() => expect(document.cleanup).toHaveBeenCalledOnce());
        await session.dispose();
    });

    it('keeps the PDF.js document until the last view leaves', async () => {
        const document = createDocumentProxy('shared');
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(document),
            destroy: vi.fn(),
        });
        const session = createPdfDocumentSession({src: computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never)});
        const left = session.attachView();
        const right = session.attachView();
        await session.load();

        await left.dispose();
        expect(session.pdfDocument.value).toBe(document);

        await right.dispose();
        expect(session.pdfDocument.value).toBeNull();
        await vi.waitFor(() => expect(document.loadingTask.destroy).toHaveBeenCalledOnce());
    });
});

describe('PdfDocumentSession residency across views', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('URL', {
            ...URL,
            createObjectURL: () => 'blob:pdf',
            revokeObjectURL: () => undefined,
        });
    });

    it('opens the PDF once when two views ask for it before it loads', async () => {
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(createDocumentProxy('shared')),
            destroy: vi.fn(),
        });
        const session = createPdfDocumentSession({src: computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never)});
        const left = session.attachView();
        const right = session.attachView();

        left.present();
        right.present();
        await vi.waitFor(() => expect(session.pdfDocument.value).not.toBeNull());
        await left.waitForLoadSettled();
        await right.waitForLoadSettled();

        expect(pdfjsState.getDocument).toHaveBeenCalledOnce();
        await session.dispose();
    });

    it('reports a view as loading while it presents a document that is already open', async () => {
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(createDocumentProxy('shared')),
            destroy: vi.fn(),
        });
        const session = createPdfDocumentSession({src: computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never)});
        session.attachView();
        await session.load();

        const loading: boolean[] = [];
        const lateView = session.attachView({emitLoading: value => loading.push(value)});
        lateView.present();
        await vi.waitFor(() => expect(loading).toEqual([
            false,
            true,
            false,
        ]));
        await session.dispose();
    });

    it('reclaims caches when the last active view leaves only after the other views have cancelled their work', async () => {
        const document = createDocumentProxy('shared');
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(document),
            destroy: vi.fn(),
        });
        const cancellation = Promise.withResolvers<undefined>();
        const rightActive = ref(true);
        const session = createPdfDocumentSession({src: computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never)});
        const left = session.attachView();
        const invalidation = vi.fn(() => cancellation.promise);
        session.attachView({isActive: computed(() => rightActive.value)})
            .subscribe(transition => transition.phase === 'invalidated'
                ? invalidation()
                : undefined);
        await session.load();

        rightActive.value = false;
        await vi.waitFor(() => expect(invalidation).toHaveBeenCalledOnce());
        await left.dispose();
        await Promise.resolve();
        expect(document.cleanup).not.toHaveBeenCalled();

        cancellation.resolve(undefined);
        await vi.waitFor(() => expect(document.cleanup).toHaveBeenCalled());
        await session.dispose();
    });
});
