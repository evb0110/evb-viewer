import {
    describe,
    expect,
    expectTypeOf,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { createDeferredWorkspaceExposeProxy } from '@app/modules/workspace-shell/expose/createDeferredWorkspaceExposeProxy';
import { createWorkspaceExpose } from '@app/modules/workspace-shell/expose/createWorkspaceExpose';
import { isWorkspaceExpose } from '@app/modules/workspace-shell/expose/isWorkspaceExpose';
import { requiredWorkspaceExposeMethods } from '@app/modules/workspace-shell/expose/requiredWorkspaceExposeMethods';
import {
    workspaceExposeCommandRegistry,
    workspaceExposeMethodDescriptors,
    workspaceExposeMenuCommandDescriptors,
    workspaceExposeRequiredMethodNames,
    workspaceExposeToolbarCommandDescriptors,
    type TWorkspaceExposeCommandName,
    type TWorkspaceExposeMethod,
} from '@app/modules/workspace-shell/expose/workspaceExposeDescriptors';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { TPdfSource } from '@app/types/pdfUi';

type TRequiredWorkspaceExposeMethod = typeof requiredWorkspaceExposeMethods[number];

function getDescriptorMethodNames() {
    return Object.values(workspaceExposeMethodDescriptors).flat();
}

function getRegistryMethodNames() {
    return workspaceExposeCommandRegistry.map(descriptor => descriptor.name);
}

function getSortedDescriptorMethodNames() {
    return [...getDescriptorMethodNames()].sort();
}

function getSortedExposeMethodNames(expose: IWorkspaceExpose) {
    return Object.entries(expose)
        .filter(([
            name,
            value,
        ]) => name !== 'hasPdf' && typeof value === 'function')
        .map(([name]) => name)
        .sort();
}

function createWorkspaceCandidate(overrides: Record<string, unknown> = {}) {
    const candidate: Record<string, unknown> = {hasPdf: false};

    for (const methodName of workspaceExposeRequiredMethodNames) {
        candidate[methodName] = vi.fn();
    }

    return {
        ...candidate,
        ...overrides,
    };
}

function createWorkspaceCandidateWithout(missingMethodName: TWorkspaceExposeMethod) {
    const candidate: Record<string, unknown> = {hasPdf: false};

    for (const methodName of workspaceExposeRequiredMethodNames) {
        if (methodName !== missingMethodName) {
            candidate[methodName] = vi.fn();
        }
    }

    return candidate;
}

function createWorkspaceExposeDeps(overrides: Partial<Parameters<typeof createWorkspaceExpose>[0]> = {}) {
    return {
        documentIdentity: ref(null),
        handleSave: vi.fn(async () => true),
        handleRepairSave: vi.fn(async () => true),
        handleOptimizePdfForInteraction: vi.fn(async () => true),
        handleSaveAs: vi.fn(async () => true),
        handlePrint: vi.fn(async () => {}),
        handlePrintCurrentPage: vi.fn(async () => {}),
        handleUndo: vi.fn(),
        handleRedo: vi.fn(),
        handleCombineImages: vi.fn(async () => true),
        handleOpenFileFromUi: vi.fn(async () => true),
        handleOpenFileDirectWithPersist: vi.fn(async (_path: string) => true),
        handleOpenFileDirectBatchWithPersist: vi.fn(async (_paths: string[]) => true),
        handleOpenFileWithResult: vi.fn(async () => true),
        handleCloseFileFromUi: vi.fn(async () => true),
        handleExportDocx: vi.fn(async () => {}),
        handleExportImages: vi.fn(async () => {}),
        handleExportMultiPageTiff: vi.fn(async () => {}),
        hasPdf: ref(false),
        isOpeningDocument: ref(false),
        initialVisualReady: ref(false),
        openingPreviewReady: ref(false),
        hasOpenError: ref(false),
        isPreparingPrint: ref(false),
        isPreparingCurrentPagePrint: ref(false),
        canSave: ref(false),
        canUndo: ref(false),
        canRedo: ref(false),
        canExportDocx: ref(false),
        isSaving: ref(false),
        isSavingAs: ref(false),
        isAnySaving: ref(false),
        isHistoryBusy: ref(false),
        isExportingDocx: ref(false),
        isFitWidthActive: ref(false),
        isFitHeightActive: ref(false),
        showSidebar: ref(false),
        dragMode: ref(false),
        continuousScroll: ref(false),
        isCapturingRegion: ref(false),
        isCropSelecting: ref(false),
        isPlacingPageNote: ref(false),
        closeAllDropdowns: vi.fn(),
        zoom: ref(1),
        effectiveZoom: ref(1),
        zoomMode: ref('custom'),
        fitMode: ref('width'),
        viewMode: ref('single'),
        viewRotation: ref(0),
        currentPage: ref(1),
        handleFitMode: vi.fn(),
        handleGoToPage: vi.fn(),
        handleToggleSidebar: vi.fn(),
        handleToggleContinuousScroll: vi.fn(),
        handleEnableDragMode: vi.fn(),
        handleDisableDragMode: vi.fn(),
        handleCaptureRegion: vi.fn(),
        handleCrop: vi.fn(),
        handleQuickNote: vi.fn(),
        handleInsertImageFromFile: vi.fn(async () => {}),
        handlePasteImageFromClipboard: vi.fn(async () => {}),
        selectedThumbnailPages: ref<number[]>([]),
        pageOpsDelete: vi.fn(async () => true),
        pageOpsExtract: vi.fn(async () => true),
        handlePageRotate: vi.fn(async () => true),
        pageOpsInsert: vi.fn(async (_totalPages: number, _afterPage: number) => true),
        pageOpsReorder: vi.fn(async () => true),
        pageOpsMove: vi.fn(async () => true),
        handleCropPages: vi.fn(async () => true),
        handlePageDelete: vi.fn(),
        handlePageReorder: vi.fn(),
        handlePageMove: vi.fn(),
        totalPages: ref(1),
        isDjvuMode: ref(false),
        openConvertDialog: vi.fn(),
        captureSplitPayload: vi.fn(async () => ({kind: 'empty' as const})),
        restoreSplitPayload: vi.fn(async () => ({status: 'cancelled' as const})),
        waitForDocumentOpenSettled: vi.fn(async () => {}),
        runAgentAction: vi.fn(async () => ({})),
        readAgentResource: vi.fn(async () => ({})),
        workingCopyPath: ref(null),
        originalPath: ref(null),
        pdfData: ref<Uint8Array | null>(null),
        pdfReloadSrc: ref<TPdfSource | null>(null),
        annotationComments: ref([]),
        annotationCommentsStatus: ref('ready'),
        annotationInventory: ref(null),
        annotationDirty: ref(false),
        sortedAnnotationNoteWindows: ref([]),
        handleOcrComplete: vi.fn(async () => {}),
        ...overrides,
    } satisfies Parameters<typeof createWorkspaceExpose>[0];
}

function createDeferredWorkspaceExposeDeps(workspace: IWorkspaceExpose | null): Parameters<typeof createDeferredWorkspaceExposeProxy>[0] {
    const enqueueDocumentOpen: Parameters<typeof createDeferredWorkspaceExposeProxy>[0]['enqueueDocumentOpen'] = async (_intent, run) => (
        run(new AbortController().signal)
    );
    return {
        enqueueDocumentOpen,
        getMounted: () => workspace,
        log: vi.fn(),
        withLoadedWorkspace: vi.fn(async (_action, run) => (
            workspace ? run(workspace) : null
        )),
        withLoadedWorkspaceRequired: vi.fn(async (_action, run) => {
            if (!workspace) {
                throw new Error('Workspace is not available.');
            }

            return run(workspace);
        }),
        withWorkspace: vi.fn(async (_action, run) => (
            workspace ? await run(workspace) !== false : false
        )),
    };
}

describe('workspace expose contract', () => {
    it('keeps the descriptor method union exhaustive for workspace expose methods', () => {
        expectTypeOf<TRequiredWorkspaceExposeMethod>().toEqualTypeOf<TWorkspaceExposeMethod>();
        expectTypeOf<TWorkspaceExposeCommandName>().toEqualTypeOf<TWorkspaceExposeMethod>();
    });

    it('derives required workspace expose methods from the descriptor method surface', () => {
        const descriptorMethodNames = getSortedDescriptorMethodNames();

        expect([...getRegistryMethodNames()].sort()).toEqual(descriptorMethodNames);
        expect([...workspaceExposeRequiredMethodNames].sort()).toEqual(descriptorMethodNames);
        expect([...requiredWorkspaceExposeMethods].sort()).toEqual(descriptorMethodNames);
    });

    it('keeps real and deferred expose method surfaces equivalent to the descriptors', () => {
        const realExpose = createWorkspaceExpose(createWorkspaceExposeDeps());
        const deferredExpose = createDeferredWorkspaceExposeProxy(createDeferredWorkspaceExposeDeps(null));
        const descriptorMethodNames = getSortedDescriptorMethodNames();

        expect(getSortedExposeMethodNames(realExpose)).toEqual(descriptorMethodNames);
        expect(getSortedExposeMethodNames(deferredExpose)).toEqual(descriptorMethodNames);
        expect(getSortedExposeMethodNames(realExpose)).toEqual(getSortedExposeMethodNames(deferredExpose));
    });

    it('keeps menu command descriptors on the registry command surface', () => {
        const registryMethodNames = new Set(getRegistryMethodNames());

        for (const descriptor of workspaceExposeMenuCommandDescriptors) {
            expect(registryMethodNames.has(descriptor.name), descriptor.name).toBe(true);
            expect(descriptor.menu.actionName).toBeTruthy();
            expect(descriptor.menu.register).toBeTruthy();
        }
    });

    it('keeps toolbar command descriptors on the registry command surface', () => {
        const registryMethodNames = new Set(getRegistryMethodNames());
        const toolbarEvents = new Set<string>();

        for (const descriptor of workspaceExposeToolbarCommandDescriptors) {
            expect(registryMethodNames.has(descriptor.name), descriptor.name).toBe(true);
            expect(descriptor.toolbar.eventName).toBeTruthy();
            expect(toolbarEvents.has(descriptor.toolbar.eventName), descriptor.toolbar.eventName).toBe(false);
            toolbarEvents.add(descriptor.toolbar.eventName);
        }

        expect(toolbarEvents).toEqual(new Set([
            'capture-region',
            'convert-to-pdf',
            'crop',
            'delete-pages',
            'disable-drag',
            'enable-drag',
            'export-docx',
            'export-images',
            'export-multi-page-tiff',
            'extract-pages',
            'fit-height',
            'fit-width',
            'go-to-page',
            'insert-image-from-file',
            'insert-pages',
            'ocr-complete',
            'optimize-pdf-for-interaction',
            'paste-image-from-clipboard',
            'print',
            'print-current-page',
            'quick-note',
            'redo',
            'repair-save',
            'rotate-ccw',
            'rotate-cw',
            'save',
            'save-as',
            'toggle-continuous-scroll',
            'toggle-sidebar',
            'undo',
        ]));
    });

    it('classifies every registry command as sync or async', () => {
        for (const descriptor of workspaceExposeCommandRegistry) {
            expect([
                'async',
                'sync',
            ]).toContain(descriptor.kind);
        }
    });

    it('accepts values that match the workspace expose contract', () => {
        expect(isWorkspaceExpose(createWorkspaceCandidate())).toBe(true);
    });

    it('rejects values without hasPdf', () => {
        const candidate = createWorkspaceCandidate();
        delete candidate.hasPdf;

        expect(isWorkspaceExpose(candidate)).toBe(false);
    });

    it('rejects values missing any descriptor method', () => {
        for (const methodName of getDescriptorMethodNames()) {
            expect(isWorkspaceExpose(createWorkspaceCandidateWithout(methodName)), methodName).toBe(false);
        }
    });

    it('rejects values where a method is not a function', () => {
        expect(isWorkspaceExpose(createWorkspaceCandidate({ handleSave: true }))).toBe(false);
    });
});
