import type * as TViMockOriginalModule from '@app/utils/document-viewer/session/documentSession';

import {
    computed,
    markRaw,
    ref,
} from 'vue';
import {
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
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TPdfSource } from '@app/types/pdfUi';
import { PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES } from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfNativePreviewRouting';
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

const driverMocks = vi.hoisted(() => ({
    cancel: vi.fn(async () => true),
    createDocumentSession: vi.fn((options: unknown) => options),
    ensurePdfProjection: vi.fn(async (
        _session: unknown,
        projection: {build: () => Promise<unknown>},
    ) => projection.build()),
    getJobState: vi.fn(async () => ({
        operation: 'djvu-print',
        status: 'handoff',
        artifactPath: '/managed/print.pdf',
    })),
    printDjvuPath: vi.fn(async () => ({
        success: true,
        canceled: false,
        jobId: 'djvu-print-job',
    })),
}));

vi.mock('@app/utils/getDjvuCapability', () => {
    const getDjvuCapability = () => ({
        cancel: driverMocks.cancel,
        getJobState: driverMocks.getJobState,
        printDjvuPath: driverMocks.printDjvuPath,
    });
    return {getDjvuCapability};
});
vi.mock('@app/utils/document-viewer/session/documentSession', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    createDocumentSession: driverMocks.createDocumentSession,
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
        nativePdfSourcePath: ref<TDocumentRef | null>(null),
        workingCopyPath: ref<TDocumentRef | null>(null),
    };
    const createDriver = (id: 'pdf' | 'native-pdf' | 'djvu') => (
        createWorkspaceDocumentDriverForAdapter(getWorkspaceViewerAdapter(id), sources)
    );
    const activeDocumentDriver = ref(createDriver('pdf'));
    const pdfViewerRef = ref<unknown>(null);
    const nativePdfViewerRef = ref<unknown>(null);
    const djvuViewerRef = ref<unknown>(null);
    const isInteractionActive = ref(false);
    const isRenderActive = ref(false);
    const isWorkspaceLayoutResizing = ref(false);
    const onAnnotationInventory = vi.fn<TAnnotationInventoryListener>();
    const onAnnotationEnrichmentState = vi.fn<TAnnotationEnrichmentStateListener>();
    const onAnnotationFailure = vi.fn();
    const onPageSourceUpdate = vi.fn();
    const onRasterSchedulerUpdate = vi.fn();
    const onSourceCapabilitiesUpdate = vi.fn();
    const pdfOpeningSrc = ref<TPdfSource | null>(null);
    const pdfOpeningRevisionToken = ref<TDocumentRevisionToken | null>(null);
    const documentRevisionToken = ref<TDocumentRevisionToken | null>(null);
    const fallbacks = new Map<PropertyKey, unknown>();
    const options = new Proxy({
        activeDocumentDriver: computed(() => activeDocumentDriver.value),
        djvuViewerRef,
        onAnnotationFailure,
        isInteractionActive,
        isRenderActive,
        isWorkspaceLayoutResizing,
        nativePdfViewerRef,
        onAnnotationEnrichmentState,
        onAnnotationInventory,
        onPageSourceUpdate,
        onRasterSchedulerUpdate,
        onSourceCapabilitiesUpdate,
        pdfSrc: ref<TPdfSource>({
            kind: 'path' as const,
            path: requireDocumentRef('/tmp/source.pdf'),
            size: 1,
        }),
        pdfOpeningSrc,
        pdfOpeningRevisionToken,
        documentRevisionToken,
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
        createDriver,
        djvuViewerRef,
        onAnnotationFailure,
        isInteractionActive,
        isRenderActive,
        isWorkspaceLayoutResizing,
        nativePdfViewerRef,
        onAnnotationEnrichmentState,
        onAnnotationInventory,
        onPageSourceUpdate,
        onRasterSchedulerUpdate,
        onSourceCapabilitiesUpdate,
        pdfViewerRef,
        pdfOpeningSrc,
        pdfOpeningRevisionToken,
    };
}

describe('WorkspaceDocumentDriver', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('keeps oversized pending PDFs on the PDF.js driver', () => {
        const oversized = selectPendingDocument(
            '/managed/document.pdf',
            PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES,
        ).activeDocumentDriver.value;
        expect(oversized).toMatchObject({
            id: 'pdfjs',
            capabilities: {
                save: true,
                sidebar: true,
            },
        });
        expect(selectPendingDocument(
            '/managed/document.pdf',
            PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES - 1,
        ).activeDocumentDriver.value?.id).toBe('pdfjs');
        expect(selectPendingDocument(
            '/managed/document.pdf',
            null,
        ).activeDocumentDriver.value?.id).toBe('pdfjs');
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
                print: {strategy: 'djvu-pdf-projection'},
            },
            view: {showDjvuSource: true},
        });

        const pdf = createWorkspaceDocumentDriverForAdapter(getWorkspaceViewerAdapter('pdf'), {
            djvuSourcePath: ref<TDocumentRef | null>(null),
            nativePdfSourcePath: ref<TDocumentRef | null>(null),
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
            print: {strategy: 'pdf'},
        });

        const save = vi.fn(async () => true);
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
        await djvuWithSave.operations.save.execute('save');
        await djvuWithSave.operations.save.execute('save-as');
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
        expect(getWorkspaceViewerAdapter('native-pdf').capabilities.sidebar).toBe(false);
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
            isResizing: true,
        });
        const pdfViewer = markRaw({});
        harness.binding.bindActiveViewerRef(pdfViewer);
        expect(harness.pdfViewerRef.value).toBe(pdfViewer);
        harness.activeDocumentDriver.value = harness.createDriver('djvu');
        expect(harness.binding.activeViewerProps.value.isInteractionActive).toBe(false);
        harness.isInteractionActive.value = true;
        expect(harness.binding.activeViewerProps.value.isInteractionActive).toBe(true);
        const djvuViewer = markRaw({});
        harness.binding.bindActiveViewerRef(djvuViewer);
        expect(harness.pdfViewerRef.value).toBeNull();
        expect(harness.nativePdfViewerRef.value).toBeNull();
        expect(harness.djvuViewerRef.value).toBe(djvuViewer);
        expect(harness.binding.activeViewerProps.value).toHaveProperty('searchResults');
        expect(harness.binding.activeViewerListeners.value['update:pageSource']).toBe(harness.onPageSourceUpdate);
        expect(harness.binding.activeViewerListeners.value['update:rasterScheduler'])
            .toBe(harness.onRasterSchedulerUpdate);
        expect(harness.binding.activeViewerListeners.value['update:sourceCapabilities']).toBe(harness.onSourceCapabilitiesUpdate);
    });

    it('binds the active driver component and renderer props for the chassis mount', () => {
        const harness = createBindingHarness();

        expect(harness.binding.activeViewerComponent.value)
            .toMatchObject({name: getWorkspaceViewerAdapter('pdf').component.name});
        expect(harness.binding.activeViewerProps.value).toMatchObject({sourceKind: 'pdf'});
        expect(harness.binding.activeViewerProps.value).not.toHaveProperty('rendererKind');

        harness.activeDocumentDriver.value = harness.createDriver('djvu');
        expect(harness.binding.activeViewerComponent.value)
            .toMatchObject({name: getWorkspaceViewerAdapter('djvu').component.name});
        expect(harness.binding.activeViewerProps.value).toMatchObject({
            sourceKind: 'djvu',
            rendererKind: 'page-source',
        });

        harness.activeDocumentDriver.value = harness.createDriver('native-pdf');
        expect(harness.binding.activeViewerComponent.value)
            .toMatchObject({name: getWorkspaceViewerAdapter('native-pdf').component.name});
        expect(harness.binding.activeViewerProps.value).toMatchObject({
            sourceKind: 'pdf',
            rendererKind: 'native-pdf',
        });
    });

    it('feeds an unvalidated opening source only to PDF.js with its fenced revision and path', () => {
        const harness = createBindingHarness();
        const revision = 'working-copy:opening' as TDocumentRevisionToken;
        harness.pdfOpeningRevisionToken.value = revision;
        harness.pdfOpeningSrc.value = {
            kind: 'path',
            path: requireDocumentRef('/tmp/staged-dictionary.pdf'),
            size: 170_496_793,
        };

        expect(harness.binding.activeViewerProps.value).toMatchObject({
            src: harness.pdfOpeningSrc.value,
            documentRevisionToken: revision,
            workingCopyPath: '/tmp/staged-dictionary.pdf',
        });
        expect(harness.activeDocumentDriver.value.id).toBe('pdfjs');
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
