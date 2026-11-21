import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed, ref, shallowRef, watch,
} from 'vue';
import { requireDocumentRef } from '@contracts/documentRef';
import {
    requireDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import type {
    IPdfDocumentTransition,
    TPdfDocumentSession,
} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import {
    createPdfSourceJob,
    type TPdfSourceJobIntent,
} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSessionSlot';
import type { IPdfViewerNativeMaterializationRequest } from '@app/modules/pdf-viewer/runtime/save/pdfViewerSaveTransaction.types';

/** Publishes a source to the session as the document does: the returned outcome is its job's. */
function admitSource(session: TPdfDocumentSession, intent: TPdfSourceJobIntent, source: unknown = session.currentJob?.source ?? null) {
    return session.admit(createPdfSourceJob(intent, {src: shallowRef(source as never)})).finished;
}

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
const {usePdfViewerSaveTransaction} = await import('@app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction');

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

/** A committed open surface that accepts a staged page-mutation revision swap. */
function createRevisionSwapAuthority(revision: TDocumentRevisionToken) {
    const surfaceSnapshot = ref({
        generation: 7,
        phase: 'ready',
        identity: {
            documentId: 'scan.pdf',
            documentRevision: revision,
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
    const source = ref<unknown>(null);
    const chassisAuthority = {
        openSurface: surface,
        source,
        bindSource: vi.fn((pageSource: unknown) => {
            source.value = pageSource;
        }),
        surfaceBudget: undefined,
    };
    return {
        surface,
        chassisAuthority: chassisAuthority as never,
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

        await session.loadPublishedSource()?.finished;

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

        await session.loadPublishedSource()?.finished;

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

        await session.loadPublishedSource()?.finished;

        expect(session.rasterScheduler).toBeNull();
        expect(session.document.value).toBeNull();
    });

    it('opens a remounted rendering subscriber after its predecessor wedged mid-open', async () => {
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
        const wedgedLoad = predecessor.loadPublishedSource()?.finished;
        await vi.waitFor(() => {
            expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        });
        expect(predecessorPhases.map(phase => phase.phase)).toEqual(['loading']);
        const wedgedFence = predecessorPhases[0]!.fence;
        await predecessor.dispose();

        const successor = createPdfDocumentSession({src: source});
        const successorView = successor.attachView();
        const viewportPhases: string[] = [];
        const renderingPhases: string[] = [];
        let renderingFence: IPdfDocumentTransition['fence'] | null = null;
        successorView.subscribe((transition) => {
            viewportPhases.push(transition.phase);
        });
        successorView.subscribe((transition) => {
            renderingPhases.push(transition.phase);
            if (transition.phase === 'ready') {
                renderingFence = transition.fence;
            }
        });

        await successor.loadPublishedSource()?.finished;

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
        expect(renderingPhases.at(-1)).toBe('settled');
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

        await session.loadPublishedSource()?.finished;

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

        await session.loadPublishedSource()?.finished;
        const fence = view.captureFence();
        expect(view.isCurrent(fence)).toBe(true);

        await session.invalidate('test');
        expect(view.isCurrent(fence)).toBe(false);
    });

    it('carries preserved reload intent through the typed transition', async () => {
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

        await session.loadPublishedSource()?.finished;
        view.preserveNextReloadVisibleContent(true);
        await admitSource(session, 'reload');

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
        ]);
    });

    it('preserves visible content when a page-mutation revision swap is staged', async () => {
        const previousRevision = requireDocumentRevisionToken('drt1:before-rotate');
        const nextRevision = requireDocumentRevisionToken('drt1:after-rotate');
        const documentRevisionToken = ref(previousRevision);
        const {
            surface, chassisAuthority,
        } = createRevisionSwapAuthority(previousRevision);
        const source = computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never);
        const session = createPdfDocumentSession({
            src: source,
            documentRevisionToken: computed(() => documentRevisionToken.value),
        });
        const view = session.attachView({
            chassisAuthority,
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
        await session.loadPublishedSource()?.finished;
        expect(view.preparePageMutationRevisionSwap(String(nextRevision), [135], 135)).toBe(true);

        documentRevisionToken.value = nextRevision;
        await admitSource(session, 'reload');

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
        await session.dispose();
    });

    it('seeds the opening geometry when an open begins and keeps measured geometry through a rewrite', async () => {
        const revision = requireDocumentRevisionToken('drt1:opening-seed');
        const {surface, chassisAuthority} = createRevisionSwapAuthority(revision);
        (surface.snapshot.value as Record<string, unknown>).openingPageGeometry = {
            documentId: 'scan.pdf',
            pageNumber: 1,
            pageCount: 1,
            width: 300,
            height: 400,
            rotation: 0,
            pages: [{widthPoints: 300, heightPoints: 400, rotation: 0, userUnit: 1}],
        };
        Object.assign(surface, {viewportSession: ref({requestedPage: 1})});
        const opening = createDeferredLoadingTask(createDocumentProxy('opened'));
        const rewrite = createDeferredLoadingTask(createDocumentProxy('rewritten'));
        pdfjsState.getDocument.mockReturnValueOnce(opening.task).mockReturnValueOnce(rewrite.task);
        const session = createPdfDocumentSession({
            src: computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never),
            documentRevisionToken: computed(() => revision),
        });
        session.attachView({
            chassisAuthority,
            originalDocumentId: computed(() => 'scan.pdf'),
            currentPage: computed(() => 1),
        });

        // While PDF.js reads, the page has the opening shape.
        const opened = admitSource(session, 'open', new Blob(['pdf'], {type: 'application/pdf'}));
        await vi.waitFor(() => expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1));
        expect(session.pageMetrics.value[0]?.width).toBe(300);
        opening.settle();
        await expect(opened).resolves.toEqual({status: 'presented'});
        // PDF.js measured the page at 100 points; the rewrite keeps that, not the opening shape.
        expect(session.pageMetrics.value[0]?.width).toBe(100);
        const rewritten = admitSource(session, 'reload');
        await vi.waitFor(() => expect(pdfjsState.getDocument).toHaveBeenCalledTimes(2));
        expect(session.pageMetrics.value[0]?.width).not.toBe(300);
        rewrite.settle();
        await expect(rewritten).resolves.toEqual({status: 'presented'});
        expect(session.pageMetrics.value[0]?.width).toBe(100);
        await session.dispose();
    });

    it('derives rotation-only geometry from cached metrics and skips replacement page measurement', async () => {
        const previousRevision = requireDocumentRevisionToken('drt1:before-fast-rotate');
        const nextRevision = requireDocumentRevisionToken('drt1:after-fast-rotate');
        const documentRevisionToken = ref(previousRevision);
        const {chassisAuthority} = createRevisionSwapAuthority(previousRevision);
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
        const session = createPdfDocumentSession({
            src: source,
            documentRevisionToken: computed(() => documentRevisionToken.value),
        });
        const view = session.attachView({chassisAuthority});
        const loadingPlans: Array<IPdfDocumentTransition['plan']> = [];
        view.subscribe((transition) => {
            if (transition.phase === 'loading' && transition.plan.isSelectiveReload) {
                loadingPlans.push(transition.plan);
            }
        });

        await session.loadPublishedSource()?.finished;
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
        await admitSource(session, 'reload');

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
        const previousRevision = requireDocumentRevisionToken('drt1:before-replace');
        const nextRevision = requireDocumentRevisionToken('drt1:after-replace');
        const documentRevisionToken = ref(previousRevision);
        const {chassisAuthority} = createRevisionSwapAuthority(previousRevision);
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
            documentRevisionToken: computed(() => documentRevisionToken.value),
        });
        const view = session.attachView({
            chassisAuthority,
            emitDocument: () => {
                if (collecting) observed.push('replacement-source-published');
            },
        });

        await session.loadPublishedSource()?.finished;
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
        expect(view.preparePageMutationRevisionSwap(String(nextRevision), [currentPage], currentPage)).toBe(true);
        documentRevisionToken.value = nextRevision;
        await admitSource(session, 'reload');

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
        void admitSource(session, 'open', source.value);

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

        session.loadPublishedSource();
        await vi.waitFor(() => {
            expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        });

        source.value = sourceB;
        void admitSource(session, 'reload', sourceB);

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

        await session.loadPublishedSource()?.finished;
        source.value = {
            ...source.value,
            revision: 'revision-b',
        };
        void admitSource(session, 'reload', source.value as never);

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

        session.loadPublishedSource();
        await vi.waitFor(() => {
            expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        });

        source.value = null;
        void admitSource(session, 'clear', null);

        await vi.waitFor(() => {
            expect(pendingA.task.destroy).toHaveBeenCalledOnce();
        });
        expect(session.document.value).toBeNull();
        expect(session.loadState.value.status).toBe('idle');
        expect(emitDocument).toHaveBeenLastCalledWith(null);

        pendingA.settle();
        await session.dispose();
    });

    it('ends a clear whose view invalidation fails', async () => {
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(createDocumentProxy('a')),
            destroy: vi.fn(),
        });
        const session = createPdfDocumentSession({src: computed(() => new Blob(['a'], {type: 'application/pdf'}) as never)});
        session.attachView().subscribe((transition) => {
            if (transition.phase === 'invalidated') throw new Error('view invalidation failed');
        });
        await session.loadPublishedSource()?.finished;

        await expect(admitSource(session, 'clear', null)).resolves.toEqual({status: 'released'});
        await session.dispose();
    });

    it('keeps the newly presented PDF when an older clear finishes', async () => {
        const a = createDocumentProxy('old');
        const b = createDocumentProxy('new');
        pdfjsState.getDocument
            .mockReturnValueOnce({promise: Promise.resolve(a), destroy: vi.fn()})
            .mockReturnValueOnce({promise: Promise.resolve(b), destroy: vi.fn()});
        const source = shallowRef<Blob | null>(new Blob(['a'], {type: 'application/pdf'}));
        const session = createPdfDocumentSession({src: computed(() => source.value as never)});
        const view = session.attachView();
        const clearStarted = Promise.withResolvers<void>();
        const releaseClear = Promise.withResolvers<void>();
        view.subscribe((transition) => {
            if (transition.phase !== 'invalidated' || transition.reason !== 'source-cleared') return;
            clearStarted.resolve();
            return releaseClear.promise;
        });

        try {
            await session.loadPublishedSource()?.finished;
            source.value = null;
            const clear = admitSource(session, 'clear', null);
            await clearStarted.promise;
            source.value = new Blob(['b'], {type: 'application/pdf'});
            await expect(admitSource(session, 'open', source.value)).resolves.toEqual({status: 'presented'});
            expect(session.document.value).toMatchObject({id: 'new'});

            releaseClear.resolve();
            await clear;
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(session.document.value).toMatchObject({id: 'new'});
        } finally {
            releaseClear.resolve();
            await session.dispose();
        }
    });

    it('a late view does not stay loading after the old loading transition rejected', async () => {
        const recovered = createDocumentProxy('recovered');
        pdfjsState.getDocument.mockReturnValue({promise: Promise.resolve(recovered), destroy: vi.fn()});
        const source = new Blob(['a'], {type: 'application/pdf'});
        const session = createPdfDocumentSession({src: computed(() => source as never)});
        const first = session.attachView();
        const unsubscribe = first.subscribe((transition) => {
            if (transition.phase === 'loading') throw new Error('injected loading transition failure');
        });

        try {
            await expect(session.loadPublishedSource()?.finished).resolves.toMatchObject({status: 'failed'});
            unsubscribe();
            const late = session.attachView();
            late.present();
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(late.isViewLoading.value).toBe(false);
        } finally {
            unsubscribe();
            await session.dispose();
        }
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

        const superseded = session.loadPublishedSource()?.finished;
        await vi.waitFor(() => {
            expect(pdfjsState.getDocument).toHaveBeenCalledTimes(1);
        });
        await admitSource(session, 'open');
        staleLoad.reject(new Error('superseded PDF parse failed'));
        await superseded;

        expect(session.document.value).toMatchObject({id: 'replacement'});
        expect(emitLoadError).not.toHaveBeenCalled();

        await admitSource(session, 'open');

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

    /** A Save that writes one page-label edit into the loaded document's bytes. */
    function pageLabelSave(saveFlowMode: 'save' | 'save_as'): IPdfViewerNativeMaterializationRequest {
        return {
            mode: 'persist',
            saveFlowMode,
            nativeCapabilities: {
                hasNativePdfMutationCapability: true,
                canPersistNativeMetadataMutations: true,
            },
            dirtyState: {annotationDirty: false, hasAnnotationChanges: false, shapeStateDirty: false},
            documentStructure: {
                pageLabelsDirty: true,
                pageLabelRanges: [{startPage: 1, style: 'D', prefix: 'Kept ', startNumber: 1}],
                bookmarksDirty: false,
                bookmarkItems: [],
                untitledBookmarkLabel: 'Untitled',
                totalPages: 1,
            },
            source: {getSourcePdfData: async () => new Uint8Array([1])},
        };
    }

    it('opens the PDF once and presents it in every view', async () => {
        pdfjsState.getDocument.mockReturnValue({
            promise: Promise.resolve(createDocumentProxy('shared')),
            destroy: vi.fn(),
        });
        const session = createPdfDocumentSession({src: computed(() => new Blob(['pdf'], {type: 'application/pdf'}) as never)});
        const left = observe(session.attachView());
        const right = observe(session.attachView());

        await session.loadPublishedSource()?.finished;

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
        await session.loadPublishedSource()?.finished;
        await admitSource(session, 'reload');
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
        await session.loadPublishedSource()?.finished;

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

    it('keeps a Save current when its view stops being active and refuses it once the source is replaced', async () => {
        const first = createDocumentProxy('first');
        const second = createDocumentProxy('second');
        pdfjsState.getDocument
            .mockReturnValueOnce({
                promise: Promise.resolve(first),
                destroy: vi.fn(),
            })
            .mockReturnValueOnce({
                promise: Promise.resolve(second),
                destroy: vi.fn(),
            });
        const src = ref(new Blob(['first'], {type: 'application/pdf'}));
        const active = ref(true);
        const session = createPdfDocumentSession({src: computed(() => src.value as never)});
        const view = observe(session.attachView({isActive: computed(() => active.value)}));
        await session.loadPublishedSource()?.finished;
        const transaction = usePdfViewerSaveTransaction({pdfDocument: session.pdfDocument});
        const save = await transaction.runSaveTransaction({
            mode: 'persist',
            nativeCapabilities: {
                hasNativePdfMutationCapability: false,
                canPersistNativeMetadataMutations: false,
            },
            dirtyState: {
                annotationDirty: false,
                hasAnnotationChanges: false,
                shapeStateDirty: false,
            },
            documentStructure: {
                pageLabelsDirty: false,
                pageLabelRanges: [],
                bookmarksDirty: false,
                bookmarkItems: [],
                untitledBookmarkLabel: 'Untitled',
                totalPages: 1,
            },
        });

        // Switching to another tab deactivates the view; the document it saves is unchanged.
        active.value = false;
        await vi.waitFor(() => expect(view.at(-1)).toBe('invalidated'));
        await expect(save.assertAnnotationSaveCurrent?.()).resolves.toBeUndefined();

        active.value = true;
        src.value = new Blob(['second'], {type: 'application/pdf'});
        void admitSource(session, 'reload', src.value);
        await vi.waitFor(() => expect(session.pdfDocument.value).toBe(second));
        await expect(save.assertAnnotationSaveCurrent?.()).rejects.toThrow('PDF document changed after the save frontier was captured');
        await session.dispose();
    });

    it('refuses to plan a Save from the document a published replacement is about to retire', async () => {
        pdfjsState.getDocument
            .mockReturnValueOnce({
                promise: Promise.resolve(createDocumentProxy('first')),
                destroy: vi.fn(),
            })
            .mockReturnValueOnce({
                promise: Promise.resolve(createDocumentProxy('second')),
                destroy: vi.fn(),
            });
        const src = ref(new Blob(['first'], {type: 'application/pdf'}));
        const session = createPdfDocumentSession({src: computed(() => src.value as never)});
        const view = session.attachView();
        await session.loadPublishedSource()?.finished;
        const invalidation = Promise.withResolvers<void>();
        view.subscribe(transition => (transition.phase === 'invalidated' ? invalidation.promise : undefined));
        src.value = new Blob(['second'], {type: 'application/pdf'});
        const replaced = admitSource(session, 'reload', src.value);

        // The old document is still loaded and usable while its views let go of it.
        const save = usePdfViewerSaveTransaction({
            pdfDocument: session.pdfDocument,
            replacingJob: session.replacingJob,
        }).runSaveTransaction(pageLabelSave('save'));
        await expect(save).rejects.toThrow('Captured PDF document is being replaced');
        invalidation.resolve();
        await expect(replaced).resolves.toEqual({status: 'presented'});
        await session.dispose();
    });

    it('plans Save and Save As from the loaded document after its replacement failed', async () => {
        const loaded = createDocumentProxy('loaded');
        pdfjsState.getDocument.mockReturnValueOnce({
            promise: Promise.resolve(loaded),
            destroy: vi.fn(),
        });
        const src = ref(new Blob(['same bytes'], {type: 'application/pdf'}));
        const revision = ref(requireDocumentRevisionToken('drt1:before-failed-replacement'));
        const session = createPdfDocumentSession({
            src: computed(() => src.value as never),
            documentRevisionToken: computed(() => revision.value),
        });
        const view = session.attachView();
        await session.loadPublishedSource()?.finished;
        const error = new Error('invalidation failed');
        view.subscribe(transition => {
            if (transition.phase === 'invalidated') throw error;
        });
        revision.value = requireDocumentRevisionToken('drt1:after-failed-replacement');
        src.value = new Blob(['same bytes'], {type: 'application/pdf'});
        await expect(admitSource(session, 'reload', src.value)).resolves.toMatchObject({status: 'failed', error});
        expect(session.pdfDocument.value).toBe(loaded);

        const transaction = usePdfViewerSaveTransaction({
            pdfDocument: session.pdfDocument,
            documentRevisionToken: computed(() => revision.value),
            replacingJob: session.replacingJob,
        });
        for (const saveFlowMode of ['save', 'save_as'] as const) {
            const planned = await transaction.runSaveTransaction(pageLabelSave(saveFlowMode));
            expect(planned.nativeMutationProjection?.mutations.pageLabels).toMatchObject({ranges: [{prefix: 'Kept '}]});
        }
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
        await session.loadPublishedSource()?.finished;

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
        await session.loadPublishedSource()?.finished;

        const loading: boolean[] = [];
        const lateView = session.attachView();
        watch(lateView.isViewLoading, value => loading.push(value), {immediate: true});
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
        await session.loadPublishedSource()?.finished;

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
