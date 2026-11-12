import {
    DB_NAME, DOCUMENTS_STORE,
} from '@app/platform/browser/browserDocumentConstants';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import {
    FakeIndexedDbFactory, MemoryStorage,
} from '@tests/unit/app/platform/browserPlatformTestDoubles';
import {requireJobId} from '@contracts/shared';
import type * as TViMockOriginalModule from '@app/modules/document-viewer/public';
import type * as TDjvuConversionPipelineModule from '@app/platform/browser-api/browserDjvuConversionPipeline';
import type * as TPageOpsCoreModule from '@app/platform/browser-api/browserPageOpsCore';

import {
    computed,
    markRaw,
    ref,
} from 'vue';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAnnotationInventoryCompleteness } from '@app/types/annotations';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import type {IDjvuPrintOptions} from '@contracts/electronApiDjvu';
import type {
    TJobId, TPdfZoomState, TPdfViewMode,
} from '@contracts/shared';
import {
    requireDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import type {TDocumentCommitReceipt} from '@app/types/workspaceExpose';
import type { TPdfSource } from '@app/types/pdfUi';
import { createDocumentSessionState } from '@app/modules/workspace-shell/composables/document-session/documentSessionState';
import {
    createWorkspaceDocumentDriverForAdapter,
    useWorkspaceDocumentDriver,
    useWorkspaceDocumentDriverBinding,
    type IWorkspaceDocumentDriverBindingOptions,
    type TAnnotationEnrichmentStateListener,
    type TAnnotationInventoryListener,
} from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import {
    WORKSPACE_VIEWER_ADAPTERS,
    getWorkspaceViewerAdapter,
} from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';

const driverMocks = vi.hoisted(() => ({
    runBrowserDjvuConversion: vi.fn(async (_source: TDocumentRef, _output: TDocumentRef) => ({success: true})),
    layoutPdfForPrint: vi.fn(async () => ({data: new Uint8Array()})),
    cancel: vi.fn(async (_jobId: TJobId) => true),
    cleanupTemp: vi.fn(async (_path: TDocumentRef) => undefined),
    createDocumentProjectionSession: vi.fn((options: unknown) => options),
    ensurePdfProjection: vi.fn(async (
        _session: unknown,
        projection: {build: () => Promise<unknown>},
    ) => projection.build()),
    getJobState: vi.fn(async () => ({
        operation: 'djvu-print',
        status: 'handoff',
        artifactPath: '/managed/print.pdf',
    })),
    printDjvuPath: vi.fn(async (_path: TDocumentRef, _options: IDjvuPrintOptions) => ({
        success: true,
        canceled: false,
        jobId: 'djvu-print-job',
    })),
}));

const platformApi = createElectronPlatformApiFixture({djvu: {
    cancel: driverMocks.cancel as never,
    cleanupTemp: driverMocks.cleanupTemp as never,
    getJobState: driverMocks.getJobState as never,
    printDjvuPath: driverMocks.printDjvuPath as never,
}});
vi.mock('@app/platform/browser-api/browserDjvuConversionPipeline', async importOriginal => ({
    ...await importOriginal<typeof TDjvuConversionPipelineModule>(),
    runBrowserDjvuConversion: driverMocks.runBrowserDjvuConversion,
}));
vi.mock('@app/platform/browser-api/browserPageOpsCore', async importOriginal => ({
    ...await importOriginal<typeof TPageOpsCoreModule>(),
    layoutPdfForPrint: driverMocks.layoutPdfForPrint,
}));
vi.mock('@app/utils/platform' , () => ({getPlatformAPI: () => platformApi}));
vi.mock('@app/modules/document-viewer/public', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    createDocumentProjectionSession: driverMocks.createDocumentProjectionSession,
    ensurePdfProjection: driverMocks.ensurePdfProjection,
}));

function selectPendingDocument(path: string, size: number | null) {
    return useWorkspaceDocumentDriver({
        djvuSourcePath: ref<TDocumentRef | null>(null),
        isDjvuMode: ref(false),
        pdfSrc: ref<TPdfSource | null>(null),
        workingCopyPath: ref<TDocumentRef | null>(null),
        pendingDocumentPath: ref<TDocumentRef | null>(requireDocumentRef(path)),
        pendingDocumentSize: ref<number | null>(size),
    });
}

function createBindingHarness() {
    const sources = {
        djvuSourcePath: ref<TDocumentRef | null>(requireDocumentRef('/tmp/source.djvu')),
        workingCopyPath: ref<TDocumentRef | null>(null),
    };
    const createDriver = (id: 'pdf' | 'djvu') => (
        createWorkspaceDocumentDriverForAdapter(getWorkspaceViewerAdapter(id), sources)
    );
    const activeDocumentDriver = ref(createDriver('pdf'));
    const pdfViewerRef = ref<unknown>(null);
    const djvuViewerRef = ref<unknown>(null);
    const isInteractionActive = ref(false);
    const isRenderActive = ref(false);
    const isWorkspaceLayoutResizing = ref(false);
    const onAnnotationInventory = vi.fn<TAnnotationInventoryListener>();
    const onAnnotationEnrichmentState = vi.fn<TAnnotationEnrichmentStateListener>();
    const onAnnotationFailure = vi.fn();
    const onPageSourceUpdate = vi.fn();
    const onSourceCapabilitiesUpdate = vi.fn();
    const documentRevisionToken = ref<TDocumentRevisionToken | null>(null);
    const zoomState = ref<TPdfZoomState>({
        kind: 'custom',
        scale: 1.25,
    });
    const viewMode = ref<TPdfViewMode>('single');
    const fallbacks = new Map<PropertyKey, unknown>();
    const options = new Proxy({
        activeDocumentDriver: computed(() => activeDocumentDriver.value),
        djvuViewerRef,
        onAnnotationFailure,
        isInteractionActive,
        isRenderActive,
        isWorkspaceLayoutResizing,
        onAnnotationEnrichmentState,
        onAnnotationInventory,
        onPageSourceUpdate,
        onSourceCapabilitiesUpdate,
        pdfSrc: ref<TPdfSource>({
            kind: 'path' as const,
            path: requireDocumentRef('/tmp/source.pdf'),
            size: 1,
        }),
        documentRevisionToken,
        zoomState,
        viewMode,
        pdfViewerRef,
        workingCopyPath: sources.workingCopyPath,
    } as Partial<IWorkspaceDocumentDriverBindingOptions>, {get(target, property) {
        if (property in target) {
            return target[property as keyof typeof target];
        }
        if (!fallbacks.has(property)) {
            fallbacks.set(property, ref(null));
        }
        return fallbacks.get(property);
    }}) as IWorkspaceDocumentDriverBindingOptions;
    return {
        activeDocumentDriver,
        binding: useWorkspaceDocumentDriverBinding(options),
        zoomState,
        viewMode,
        createDriver,
        djvuViewerRef,
        onAnnotationFailure,
        isInteractionActive,
        isRenderActive,
        isWorkspaceLayoutResizing,
        onAnnotationEnrichmentState,
        onAnnotationInventory,
        onPageSourceUpdate,
        onSourceCapabilitiesUpdate,
        pdfViewerRef,
    };
}

describe('WorkspaceDocumentDriver', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('uses the source filename when a PDF has a generic managed working copy', () => {
        const state = createDocumentSessionState({
            isDesktopRuntime: ref(true),
            document: createWorkspaceDocumentController({tabId: 'tab-1'}),
        });
        state.workingCopyPath.value = requireDocumentRef('/tmp/pdf-work-123/document.pdf');
        state.originalPath.value = requireDocumentRef(
            '/Users/evb/Desktop/pdf/Haspelmath_Sims (2010) - Understanding Morphology.pdf',
        );

        expect(state.fileName.value).toBe('Haspelmath_Sims (2010) - Understanding Morphology.pdf');
    });

    it('selects DjVu source behavior and returns typed unavailable commands for PDF.js', async () => {
        const djvu = useWorkspaceDocumentDriver({
            djvuSourcePath: ref<TDocumentRef | null>(requireDocumentRef('/managed/source.djvu')),
            isDjvuMode: ref(true),
            pdfSrc: ref<TPdfSource | null>(null),
            workingCopyPath: ref<TDocumentRef | null>(null),
        }).activeDocumentDriver.value;
        expect(djvu).toMatchObject({
            id: 'djvu',
            lifecycle: {createHooks: expect.any(Function)},
            source: {
                kind: 'djvu',
                path: '/managed/source.djvu',
            },
            operations: {
                save: {strategy: 'djvu-pdf-projection'},
                export: {imageTarget: {
                    sourceKind: 'djvu',
                    sourcePath: '/managed/source.djvu',
                    requiresFreshWorkingCopy: false,
                }},
                print: {
                    strategy: 'djvu-pdf-projection',
                    path: null,
                },
            },
            view: {showDjvuSource: true},
        });

        const pdf = createWorkspaceDocumentDriverForAdapter(getWorkspaceViewerAdapter('pdf'), {
            djvuSourcePath: ref<TDocumentRef | null>(null),
            workingCopyPath: ref<TDocumentRef | null>(null),
        });
        expect(pdf.operations).toEqual({
            save: {
                strategy: 'pdf-working-copy',
                execute: expect.any(Function),
            },
            export: {
                imageTarget: null,
                multiPageTiffTarget: null,
            },
            print: {
                strategy: 'pdf',
                path: null,
            },
        });

        const workingCopyPath = ref<TDocumentRef | null>(requireDocumentRef('/managed/working.pdf'));
        const pdfWithPrintPath = createWorkspaceDocumentDriverForAdapter(getWorkspaceViewerAdapter('pdf'), {
            djvuSourcePath: ref<TDocumentRef | null>(null),
            workingCopyPath,
        });
        expect(pdfWithPrintPath.operations.print.path).toBe('/managed/working.pdf');

        const committed = requireDocumentRevisionToken('driver-own-save');
        const receipts: Array<typeof committed> = [];
        const save = vi.fn(async (onCommitted?: TDocumentCommitReceipt) => {
            onCommitted?.(committed);
            return true;
        });
        const saveAs = vi.fn(async () => true);
        const saveAsDjvuProjection = vi.fn(async () => true);
        const djvuWithSave = useWorkspaceDocumentDriver({
            djvuSourcePath: ref<TDocumentRef | null>(requireDocumentRef('/managed/source.djvu')),
            isDjvuMode: ref(true),
            pdfSrc: ref<TPdfSource | null>(null),
            workingCopyPath: ref<TDocumentRef | null>(null),
            save: {
                save,
                saveAs,
                saveAsDjvuProjection,
            },
        }).activeDocumentDriver.value!;
        await djvuWithSave.operations.save.execute('save', revision => receipts.push(revision));
        await djvuWithSave.operations.save.execute('save-as');
        expect(receipts).toEqual([committed]);
        expect(save).toHaveBeenCalledOnce();
        expect(saveAs).not.toHaveBeenCalled();
        expect(saveAsDjvuProjection).toHaveBeenCalledOnce();

        await expect(selectPendingDocument('/managed/document.pdf', 1).activeDocumentDriver.value?.run({
            kind: 'prepare-print',
            request: {
                orientation: 'portrait',
                viewMode: 'single',
            },
            fileName: null,
            sourceCapabilities: djvu!.view.defaultSourceCapabilities ?? {
                annotations: false,
                directImageExport: false,
                outline: false,
                pageEdits: false,
                search: false,
                text: false,
            },
        })).resolves.toEqual({
            status: 'unavailable',
            capability: 'print',
        });
    });

    it('routes DjVu print through its projection and waits for output handoff', async () => {
        const driver = useWorkspaceDocumentDriver({
            djvuSourcePath: ref<TDocumentRef | null>(requireDocumentRef('/managed/source.djvu')),
            isDjvuMode: ref(true),
            pdfSrc: ref<TPdfSource | null>(null),
            workingCopyPath: ref<TDocumentRef | null>(null),
        }).activeDocumentDriver.value!;
        const onNativePrintHandoffStart = vi.fn();
        const signal = new AbortController().signal;

        await expect(driver.run({
            kind: 'prepare-print',
            request: {
                orientation: 'portrait',
                viewMode: 'single',
            },
            fileName: 'source.djvu',
            sourceCapabilities: {
                annotations: false,
                directImageExport: true,
                outline: false,
                pageEdits: false,
                search: false,
                text: false,
            },
            onNativePrintHandoffStart,
            signal,
        })).resolves.toEqual({status: 'completed'});

        expect(driverMocks.ensurePdfProjection).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({build: expect.any(Function)}),
            'print',
            signal,
        );
        expect(driverMocks.printDjvuPath).toHaveBeenCalledWith(
            '/managed/source.djvu',
            expect.objectContaining({
                fileName: 'source.djvu',
                orientation: 'portrait',
                pdfStrategy: 'compact-djvu-aware',
                viewMode: 'single',
            }),
        );
        expect(driverMocks.getJobState).toHaveBeenCalledWith('djvu-print-job');
        expect(driverMocks.getJobState.mock.invocationCallOrder[0])
            .toBeLessThan(onNativePrintHandoffStart.mock.invocationCallOrder[0]!);
    });

    it('hands a PDF the platform prepared without printing it to the workspace print', async () => {
        driverMocks.printDjvuPath.mockResolvedValueOnce({
            success: true,
            canceled: false,
            jobId: 'djvu-print-job',
            printablePdfPath: requireDocumentRef('browser://documents/source-print.pdf'),
        } as never);
        driverMocks.getJobState.mockResolvedValueOnce({
            operation: 'djvu-print',
            status: 'completed',
            artifactPath: 'browser://documents/source-print.pdf',
        });
        const driver = useWorkspaceDocumentDriver({
            djvuSourcePath: ref<TDocumentRef | null>(requireDocumentRef('browser://documents/source.djvu')),
            isDjvuMode: ref(true),
            pdfSrc: ref<TPdfSource | null>(null),
            workingCopyPath: ref<TDocumentRef | null>(null),
        }).activeDocumentDriver.value!;
        const onNativePrintHandoffStart = vi.fn();

        const result = await driver.run({
            kind: 'prepare-print',
            request: {
                orientation: 'auto',
                viewMode: 'single',
                pageNumbers: [2],
            },
            fileName: 'source.djvu',
            sourceCapabilities: driver.view.defaultSourceCapabilities ?? {
                annotations: false,
                directImageExport: false,
                outline: false,
                pageEdits: false,
                search: false,
                text: false,
            },
            onNativePrintHandoffStart,
        });

        expect(result).toMatchObject({
            status: 'printable-pdf',
            documentRef: 'browser://documents/source-print.pdf',
        });
        expect(onNativePrintHandoffStart).not.toHaveBeenCalled();
        await (result as {release: () => Promise<void>}).release();
        expect(driverMocks.cleanupTemp).toHaveBeenCalledWith('browser://documents/source-print.pdf');
    });

    it('cancels the admitted native print job before its dialog handoff', async () => {
        const admitted = Promise.withResolvers<undefined>();
        const preparation = Promise.withResolvers<undefined>();
        let nativeJobId: string | undefined;
        let canceled = false;
        const dialog = vi.fn();
        driverMocks.printDjvuPath.mockImplementationOnce(async (_path, options) => {
            const admittedJobId = `djvu-print-${options.requestId}`;
            nativeJobId = admittedJobId;
            admitted.resolve(undefined);
            await preparation.promise;
            if (!canceled) dialog();
            return {
                success: !canceled,
                canceled,
                jobId: admittedJobId,
            };
        });
        driverMocks.cancel.mockImplementationOnce(async jobId => {
            canceled = jobId === nativeJobId;
            preparation.resolve(undefined);
            return canceled;
        });
        const driver = useWorkspaceDocumentDriver({
            djvuSourcePath: ref<TDocumentRef | null>(requireDocumentRef('/managed/source.djvu')),
            isDjvuMode: ref(true),
            pdfSrc: ref<TPdfSource | null>(null),
            workingCopyPath: ref<TDocumentRef | null>(null),
        }).activeDocumentDriver.value!;
        const controller = new AbortController();
        const result = driver.run({
            kind: 'prepare-print',
            request: {
                orientation: 'portrait',
                viewMode: 'single',
            },
            fileName: 'source.djvu',
            sourceCapabilities: {
                annotations: false,
                directImageExport: true,
                outline: false,
                pageEdits: false,
                search: false,
                text: false,
            },
            signal: controller.signal,
        }).catch(error => error as Error);
        await admitted.promise;
        controller.abort();
        expect(await result).toMatchObject({name: 'AbortError'});
        expect(dialog).not.toHaveBeenCalled();
    });

    it('does not invent an abort signal when DjVu print has no cancellation source', async () => {
        const driver = useWorkspaceDocumentDriver({
            djvuSourcePath: ref<TDocumentRef | null>(requireDocumentRef('/managed/source.djvu')),
            isDjvuMode: ref(true),
            pdfSrc: ref<TPdfSource | null>(null),
            workingCopyPath: ref<TDocumentRef | null>(null),
        }).activeDocumentDriver.value!;

        await expect(driver.run({
            kind: 'prepare-print',
            request: {
                orientation: 'portrait',
                viewMode: 'single',
            },
            fileName: null,
            sourceCapabilities: {
                annotations: false,
                directImageExport: true,
                outline: false,
                pageEdits: false,
                search: false,
                text: false,
            },
        })).resolves.toEqual({status: 'completed'});

        expect(driverMocks.ensurePdfProjection).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({build: expect.any(Function)}),
            'print',
            undefined,
        );
    });

    it('keeps the compatibility registry complete with capability and lifecycle parity', () => {
        const documentTypes = new Set(WORKSPACE_VIEWER_ADAPTERS.flatMap(adapter => adapter.documentTypes));
        expect(documentTypes).toEqual(new Set([
            'pdf',
            'image',
            'djvu',
        ]));
        expect(getWorkspaceViewerAdapter('pdf').capabilities).toMatchObject({
            repairSave: true,
            save: true,
            sidebar: true,
        });
        expect(getWorkspaceViewerAdapter('djvu')).toMatchObject({
            capabilities: {
                conversionDialog: true,
                saveAs: true,
            },
            createLifecycleHooks: expect.any(Function),
        });
    });
    it('routes annotation creation failures to the workspace for the PDF.js driver only', () => {
        const harness = createBindingHarness();

        // The bridge renders no failure UI itself, so an unbound listener
        // means every rejected annotation reaches nobody.
        expect(harness.binding.activeViewerListeners.value.annotationFailure)
            .toBe(harness.onAnnotationFailure);

        harness.activeDocumentDriver.value = harness.createDriver('djvu');

        // DjVu has no annotation editor, so it emits no failures to route.
        expect(harness.binding.activeViewerListeners.value).not.toHaveProperty('annotationFailure');
    });

    it('owns viewer bindings, source listeners, and reactive presentation behind the driver', () => {
        const harness = createBindingHarness();
        expect(harness.binding.activeViewerProps.value.isActive).toBe(false);
        harness.isRenderActive.value = true;
        harness.isWorkspaceLayoutResizing.value = true;
        expect(harness.binding.activeViewerProps.value).toMatchObject({
            isActive: true,
            isInteractionActive: false,
            isResizing: true,
            src: {
                kind: 'path',
                path: '/tmp/source.pdf',
                size: 1,
            },
            zoomState: {
                kind: 'custom',
                scale: 1.25,
            },
            viewMode: 'single',
        });
        harness.isInteractionActive.value = true;
        harness.zoomState.value = {
            kind: 'fit',
            axis: 'width',
        };
        expect(harness.binding.activeViewerProps.value).toMatchObject({
            isActive: true,
            isInteractionActive: true,
            zoomState: {
                kind: 'fit',
                axis: 'width',
            },
        });
        harness.isInteractionActive.value = false;
        const pdfViewer = markRaw({});
        harness.binding.bindActiveViewerRef(pdfViewer);
        expect(harness.pdfViewerRef.value).toBe(pdfViewer);
        harness.activeDocumentDriver.value = harness.createDriver('djvu');
        expect(harness.binding.activeViewerProps.value).toMatchObject({
            src: '/tmp/source.djvu',
            isActive: true,
            isInteractionActive: false,
            zoomState: {
                kind: 'fit',
                axis: 'width',
            },
            viewMode: 'single',
        });
        harness.isInteractionActive.value = true;
        expect(harness.binding.activeViewerProps.value.isInteractionActive).toBe(true);
        const djvuViewer = markRaw({});
        harness.binding.bindActiveViewerRef(djvuViewer);
        expect(harness.pdfViewerRef.value).toBeNull();
        expect(harness.djvuViewerRef.value).toBe(djvuViewer);
        expect(harness.binding.activeViewerProps.value).toHaveProperty('searchResults');
        expect(harness.binding.activeViewerListeners.value['update:pageSource']).toBe(harness.onPageSourceUpdate);
        expect(harness.binding.activeViewerListeners.value['update:sourceCapabilities']).toBe(harness.onSourceCapabilitiesUpdate);
    });

    it('binds the active driver component and renderer props for the chassis mount', () => {
        const harness = createBindingHarness();

        expect(harness.binding.activeViewerComponent.value)
            .toMatchObject({name: getWorkspaceViewerAdapter('pdf').component.name});
        expect(harness.binding.activeViewerProps.value).toMatchObject({sourceKind: 'pdf'});
        expect(harness.binding.activeViewerProps.value).toMatchObject({rendererKind: 'pdfjs'});

        harness.activeDocumentDriver.value = harness.createDriver('djvu');
        expect(harness.binding.activeViewerComponent.value)
            .toMatchObject({name: getWorkspaceViewerAdapter('djvu').component.name});
        expect(harness.binding.activeViewerProps.value).toMatchObject({
            sourceKind: 'djvu',
            rendererKind: 'page-source',
        });
    });

    it('routes annotation inventory completeness only from the pdf.js driver', () => {
        const harness = createBindingHarness();
        expect(harness.binding.activeViewerListeners.value.annotationInventory)
            .toBe(harness.onAnnotationInventory);
        harness.activeDocumentDriver.value = harness.createDriver('djvu');
        expect(harness.binding.activeViewerListeners.value.annotationInventory).toBeUndefined();
    });

    it('forwards the viewer completeness record and its pending null unchanged', () => {
        const harness = createBindingHarness();
        // The listener leaves here as a typed handler, not an `unknown` entry
        // in a `v-on` bag, so the workspace side sees the same contract the
        // viewer emits.
        const listener: TAnnotationInventoryListener | undefined
            = harness.binding.activeViewerListeners.value.annotationInventory;
        expect(listener).toBeDefined();

        const completeness: IAnnotationInventoryCompleteness = {
            complete: false,
            omissions: ['page-parse-failure'],
            scannedPageCount: 3,
            totalPageCount: 4,
            failedPageCount: 1,
        };
        listener?.(completeness);
        listener?.(null);

        expect(harness.onAnnotationInventory).toHaveBeenNthCalledWith(1, completeness);
        // `null` is the "no inventory measured yet" signal and must survive the
        // hop; collapsing it into a complete record would hide the notice.
        expect(harness.onAnnotationInventory).toHaveBeenNthCalledWith(2, null);
    });

    it('routes the annotation enrichment verdict to the workspace only for the PDF.js viewer', () => {
        const harness = createBindingHarness();

        // Without this listener the annotations panel never learns that a
        // document's annotation read was skipped, and silently shows unknown
        // authors instead.
        expect(harness.binding.activeViewerListeners.value.annotationEnrichmentState)
            .toBe(harness.onAnnotationEnrichmentState);

        harness.activeDocumentDriver.value = harness.createDriver('djvu');

        expect(harness.binding.activeViewerListeners.value.annotationEnrichmentState).toBeUndefined();
    });
});


describe('DjVu print layout cancellation storage', () => {
    afterEach(() => vi.unstubAllGlobals());
    it('starts no conversion when canceled while its output is being created', async () => {
        const indexedDb = new FakeIndexedDbFactory();
        vi.stubGlobal('indexedDB', indexedDb);
        vi.stubGlobal('localStorage', new MemoryStorage());
        const {prepareBrowserDjvuPrint} = await import('@app/platform/browser-api/prepareBrowserDjvuPrint');
        const {browserDjvuCapability} = await import('@app/platform/browser-api/browserDjvuCapability');
        const createStarted = Promise.withResolvers<undefined>();
        const releaseCreate = Promise.withResolvers<undefined>();
        const createStoredDocument = browserDocumentStore.createStoredDocument.bind(browserDocumentStore);
        const create = vi.spyOn(browserDocumentStore, 'createStoredDocument').mockImplementationOnce(async (...args) => {
            createStarted.resolve(undefined);
            await releaseCreate.promise;
            return createStoredDocument(...args);
        });
        let printResult: Awaited<ReturnType<typeof prepareBrowserDjvuPrint>> | null = null;
        driverMocks.printDjvuPath.mockImplementationOnce(async (source, options) => {
            printResult = await prepareBrowserDjvuPrint(source, options, requireJobId(`djvu-print-${options.requestId}`));
            return printResult as never;
        });
        driverMocks.cancel.mockImplementationOnce(async jobId => (await browserDjvuCapability.cancel(jobId)).canceled);
        const driver = useWorkspaceDocumentDriver({
            djvuSourcePath: ref<TDocumentRef | null>(requireDocumentRef('browser://documents/create-cancel.djvu')),
            isDjvuMode: ref(true),
            pdfSrc: ref<TPdfSource | null>(null),
            workingCopyPath: ref<TDocumentRef | null>(null),
        }).activeDocumentDriver.value!;
        const controller = new AbortController();
        try {
            const outcome = driver.run({
                kind: 'prepare-print',
                request: {
                    orientation: 'auto',
                    viewMode: 'single',
                },
                fileName: 'create-cancel.djvu',
                sourceCapabilities: driver.view.defaultSourceCapabilities!,
                signal: controller.signal,
                onNativePrintHandoffStart: vi.fn(),
            }).catch(error => error as Error);
            await createStarted.promise;
            controller.abort();
            releaseCreate.resolve(undefined);

            expect(await outcome).toMatchObject({name: 'AbortError'});
            await vi.waitFor(() => expect(printResult).toMatchObject({canceled: true}));
            expect(driverMocks.runBrowserDjvuConversion).not.toHaveBeenCalled();
            expect(indexedDb.getDatabase(DB_NAME)?.getStoreRecords(DOCUMENTS_STORE).size ?? 0).toBe(0);
        } finally {
            create.mockRestore();
        }
    });

    it('leaves no stored PDF when canceled during layout', async () => {
        const indexedDb = new FakeIndexedDbFactory();
        vi.stubGlobal('indexedDB', indexedDb);
        vi.stubGlobal('localStorage', new MemoryStorage());
        const {prepareBrowserDjvuPrint} = await import('@app/platform/browser-api/prepareBrowserDjvuPrint');
        const {browserDjvuCapability} = await import('@app/platform/browser-api/browserDjvuCapability');
        const layoutStarted = Promise.withResolvers<undefined>();
        const layout = Promise.withResolvers<{data: Uint8Array<ArrayBuffer>}>();
        let convertedPath: TDocumentRef | null = null;
        let printResult: Awaited<ReturnType<typeof prepareBrowserDjvuPrint>> | null = null;
        driverMocks.runBrowserDjvuConversion.mockImplementationOnce(async (_source, output) => {
            convertedPath = output;
            await browserDocumentStore.write(output, new TextEncoder().encode('%PDF-converted'));
            return {success: true};
        });
        driverMocks.layoutPdfForPrint.mockImplementationOnce(() => {
            layoutStarted.resolve(undefined);
            return layout.promise;
        });
        driverMocks.printDjvuPath.mockImplementationOnce(async (source, options) => {
            const result = await prepareBrowserDjvuPrint(source, options, requireJobId(`djvu-print-${options.requestId}`));
            printResult = result;
            return result as never;
        });
        driverMocks.cancel.mockImplementationOnce(async jobId => (await browserDjvuCapability.cancel(jobId)).canceled);
        const driver = useWorkspaceDocumentDriver({
            djvuSourcePath: ref<TDocumentRef | null>(requireDocumentRef('browser://documents/layout-cancel.djvu')),
            isDjvuMode: ref(true),
            pdfSrc: ref<TPdfSource | null>(null),
            workingCopyPath: ref<TDocumentRef | null>(null),
        }).activeDocumentDriver.value!;
        const controller = new AbortController();
        const onNativePrintHandoffStart = vi.fn();
        const outcome = driver.run({
            kind: 'prepare-print',
            request: {
                orientation: 'portrait',
                viewMode: 'single',
            },
            fileName: 'layout-cancel.djvu',
            sourceCapabilities: driver.view.defaultSourceCapabilities!,
            signal: controller.signal,
            onNativePrintHandoffStart,
        }).catch(error => error as Error);
        await Promise.race([
            layoutStarted.promise,
            outcome.then(error => { throw error; }),
        ]);
        controller.abort();
        layout.resolve({data: new TextEncoder().encode('%PDF-laid-out')});
        expect(await outcome).toMatchObject({name: 'AbortError'});
        expect(convertedPath).not.toBeNull();
        expect(printResult).toMatchObject({
            success: false,
            canceled: true,
        });
        expect(printResult).not.toHaveProperty('printablePdfPath');
        expect(await browserDocumentStore.exists(convertedPath!)).toBe(false);
        expect(indexedDb.getDatabase(DB_NAME)?.getStoreRecords(DOCUMENTS_STORE).size).toBe(0);
        expect(onNativePrintHandoffStart).not.toHaveBeenCalled();
    });
});
