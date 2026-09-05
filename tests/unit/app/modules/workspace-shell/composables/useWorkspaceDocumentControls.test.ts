import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
} from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';

const mocks = vi.hoisted(() => ({
    pageOpsDeps: null as null | {
        onExtractedDocument?: (path: TDocumentRef) => Promise<void> | void;
        ensureWorkingCopyFreshForRead?: () => Promise<boolean>;
        canMutatePages?: unknown;
        documentRevisionToken?: unknown;
    },
    statusBarDeps: null as null | {
        hasSaveFailure?: unknown;
        workingCopyPath?: unknown;
    },
}));

vi.mock('@app/modules/workspace-shell/composables/usePageStatusBar', () => ({usePageStatusBar: (deps: {workingCopyPath?: unknown}) => {
    mocks.statusBarDeps = deps;
    return {statusMaterializationLabel: ref('Preparing document')};
}}));

vi.mock('@app/modules/workspace-shell/composables/usePageOpsHandlers', () => ({ usePageOpsHandlers: (deps: unknown) => {
    mocks.pageOpsDeps = deps as {
        onExtractedDocument?: (path: TDocumentRef) => Promise<void> | void;
        ensureWorkingCopyFreshForRead?: () => Promise<boolean>;
        canMutatePages?: unknown;
        documentRevisionToken?: unknown;
    };
    return {};
} }));

vi.mock('@app/modules/workspace-shell/composables/usePageFileOperations', () => ({ usePageFileOperations: () => ({}) }));

const { useWorkspaceDocumentControls } = await import('@app/modules/workspace-shell/composables/useWorkspaceDocumentControls');

const openedOutcome: TDocumentOpenOutcome = {
    status: 'opened',
    result: {
        kind: 'pdf',
        originalPath: '/tmp/source.pdf',
        workingPath: '/tmp/working.pdf',
    },
};

function createOptions() {
    return {
        hasDocument: ref(false),
        pdfSrc: ref(null),
        pdfData: ref(null),
        originalPath: ref<TDocumentRef | null>(null),
        workingCopyPath: ref<TDocumentRef | null>(null),
        documentRevisionToken: ref<TDocumentRevisionToken | null>(null),
        currentPage: ref(1),
        effectiveZoom: ref(1),
        canSave: ref(false),
        hasSaveFailure: ref(false),
        isAnySaving: ref(false),
        isHistoryBusy: ref(false),
        canMutatePages: ref(true),
        handleSave: vi.fn(async () => {}),
        totalPages: ref(1),
        selectedThumbnailPages: ref<number[]>([]),
        setSelectedThumbnailPages: vi.fn(),
        requestThumbnailInvalidation: vi.fn(),
        pdfViewerRef: ref(null),
        pageContextMenu: ref({
            visible: false,
            pages: [],
        }),
        closePageContextMenu: vi.fn(),
        handleExportImages: vi.fn(async () => {}),
        ensureHistoryBaselineForMutation: vi.fn(async () => true),
        reloadWorkingCopyIntoHistory: vi.fn(async () => true),
        preparePdfReloadWaiter: vi.fn(() => ({
            promise: Promise.resolve(),
            cancel: vi.fn(),
        })),
        clearOcrCache: vi.fn(),
        resetSearchCache: vi.fn(),
        ensureWorkingCopyFreshForRead: vi.fn(async () => true),
        isExportingDocx: ref(false),
        isAnyAnnotationNoteSaving: ref(false),
        annotationNoteWindows: ref([]),
        hasPendingUnsavedChanges: computed(() => false),
        annotationDirty: ref(false),
        isDirty: ref(false),
        pageLabelsDirty: ref(false),
        pageLabels: ref([]),
        bookmarksDirty: ref(false),
        bookmarkItems: ref([]),
        hasAnnotationChanges: vi.fn(() => false),
        persistAllAnnotationNotes: vi.fn(async () => true),
        saveAnnotationsForPageMutation: vi.fn(async () => true),
        pickFileToOpen: vi.fn(async () => null),
        openFileWithViewerLifecycle: vi.fn(async () => openedOutcome),
        openFileDirectWithViewerLifecycle: vi.fn(async () => openedOutcome),
        openFileDirectBatchWithViewerLifecycle: vi.fn(async () => openedOutcome),
        closeFileWithViewerLifecycle: vi.fn(async () => {}),
        closeAllDropdowns: vi.fn(),
        emitOpenInNewTab: vi.fn(),
        removeRecentFileIfMissing: vi.fn(async () => false),
    };
}

describe('useWorkspaceDocumentControls', () => {
    beforeEach(() => {
        mocks.pageOpsDeps = null;
        mocks.statusBarDeps = null;
        vi.clearAllMocks();
    });

    it('reopens extracted PDFs by original path so the new tab creates its own working copy', async () => {
        const options = createOptions();

        useWorkspaceDocumentControls(options);

        expect(mocks.pageOpsDeps?.onExtractedDocument).toBeTypeOf('function');

        await mocks.pageOpsDeps?.onExtractedDocument?.('C:\\Users\\andrej\\Downloads\\extract.pdf');

        expect(options.emitOpenInNewTab).toHaveBeenCalledWith('C:\\Users\\andrej\\Downloads\\extract.pdf');
    });

    it('keeps backing status derived inside the status-bar composable', () => {
        const options = createOptions();
        const controls = useWorkspaceDocumentControls(options);

        expect(mocks.statusBarDeps?.workingCopyPath).toBe(options.workingCopyPath);
        // Without this the status bar cannot express a failed save at all.
        expect(mocks.statusBarDeps?.hasSaveFailure).toBe(options.hasSaveFailure);
        expect(controls.statusMaterializationLabel.value).toBe('Preparing document');
    });
});
