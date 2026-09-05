import {
    expect,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
    type Ref,
} from 'vue';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/public';
import type {IWorkspaceSaveDependencies} from '@app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService';
import {useWorkspaceSaveService} from '@app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService';
import { usePdfViewerSaveTransaction } from '@app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction';
import {
    asAnnotationId,
    deriveAnnotationId,
    type AnnotationEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {buildSerializationPlan} from '@app/modules/pdf-viewer/annotations/persistence/annotationSavePlan';
import { cast } from '@tests/helpers/cast';

export const toastAddMock = vi.fn();
const TEST_BROWSER_SOURCE_REF = 'browser://documents/source.pdf';
const TEST_BROWSER_WORKING_COPY_REF = 'browser://documents/work.pdf';
type TFileOperationsSaveControllerTestDeps =
    IWorkspaceSaveDependencies['status']
    & {
        workingCopyPath: IWorkspaceSaveDependencies['document']['workingCopyPath'];
        originalPath: IWorkspaceSaveDependencies['document']['originalPath'];
        documentSessionKey: IWorkspaceSaveDependencies['document']['sessionKey'];
        documentRevisionToken: IWorkspaceSaveDependencies['document']['revisionToken'];
        wasEncrypted?: NonNullable<IWorkspaceSaveDependencies['document']['wasEncrypted']>;
        suppressUnencryptedSaveNotice?: NonNullable<
            IWorkspaceSaveDependencies['unencryptedSaveNotice']
        >['suppress'];
        requestUnencryptedSaveNotice?: NonNullable<
            IWorkspaceSaveDependencies['unencryptedSaveNotice']
        >['request'];
        updateSuppressUnencryptedSaveNotice?: NonNullable<
            IWorkspaceSaveDependencies['unencryptedSaveNotice']
        >['updateSuppress'];
        resetSuppressUnencryptedSaveNotice?: NonNullable<
            IWorkspaceSaveDependencies['unencryptedSaveNotice']
        >['resetSuppress'];
        flushSettings?: NonNullable<
            IWorkspaceSaveDependencies['unencryptedSaveNotice']
        >['flushSettings'];
        annotationDirty: IWorkspaceSaveDependencies['annotations']['dirty'];
        markAnnotationSaved: IWorkspaceSaveDependencies['annotations']['markSaved'];
        getAnnotationSaveStateToken?: IWorkspaceSaveDependencies['annotations']['getSaveStateToken'];
        hasAnnotationChanges: IWorkspaceSaveDependencies['annotations']['hasChanges'];
        hasPendingAnnotationDeletes?: IWorkspaceSaveDependencies['annotations']['hasPendingDeletes'];
        annotationNoteWindowsCount: IWorkspaceSaveDependencies['annotations']['openNoteCount'];
        persistAllAnnotationNotes: IWorkspaceSaveDependencies['annotations']['persistOpenNotes'];
        totalPages: IWorkspaceSaveDependencies['metadata']['totalPages'];
        pageLabelsDirty: IWorkspaceSaveDependencies['metadata']['pageLabelsDirty'];
        pageLabelRanges: IWorkspaceSaveDependencies['metadata']['pageLabelRanges'];
        bookmarksDirty: IWorkspaceSaveDependencies['metadata']['bookmarksDirty'];
        bookmarkItems: IWorkspaceSaveDependencies['metadata']['bookmarkItems'];
        untitledBookmarkLabel: string;
        markPageLabelsSaved: IWorkspaceSaveDependencies['metadata']['markPageLabelsSaved'];
        getPageLabelsSaveStateToken?: IWorkspaceSaveDependencies['metadata']['getPageLabelsSaveStateToken'];
        markBookmarksSaved: IWorkspaceSaveDependencies['metadata']['markBookmarksSaved'];
        getBookmarksSaveStateToken?: IWorkspaceSaveDependencies['metadata']['getBookmarksSaveStateToken'];
        pdfDocument: IWorkspaceSaveDependencies['pdf']['document'];
        commitPdfEditorsForSave?: IWorkspaceSaveDependencies['pdf']['commitEditorsForSave'];
        runSaveTransaction: IWorkspaceSaveDependencies['pdf']['runSaveTransaction'];
        getSourcePdfData: IWorkspaceSaveDependencies['pdf']['getSourceData'];
        serializePdfForSave: IWorkspaceSaveDependencies['pdf']['serializeForSave'];
        validatePdfPath: IWorkspaceSaveDependencies['persistence']['validatePdfPath'];
        saveFile: IWorkspaceSaveDependencies['persistence']['saveSerialized'];
        saveWorkingCopy: IWorkspaceSaveDependencies['persistence']['saveWorkingCopy'];
        saveWorkingCopyAs: IWorkspaceSaveDependencies['persistence']['saveAs'];
        repairWorkingCopy?: IWorkspaceSaveDependencies['persistence']['repairWorkingCopy'];
        optimizeWorkingCopy?: IWorkspaceSaveDependencies['persistence']['optimizeWorkingCopy'];
        optimizeWorkingCopyAsCopy?: IWorkspaceSaveDependencies['persistence']['optimizeWorkingCopyAsCopy'];
        optimizePdfOnSaveAs?: Ref<boolean>;
        trySavePdfNativeMutations?: IWorkspaceSaveDependencies['persistence']['trySavePdfNativeMutations'];
        trySaveEmbeddedNoteTextUpdates?: IWorkspaceSaveDependencies['persistence']['trySaveEmbeddedNoteTextUpdates'];
        getWorkingCopySize?: IWorkspaceSaveDependencies['persistence']['getWorkingCopySize'];
        hasShapeChanges?: () => boolean;
        hasManagedShapes?: () => boolean;
        getAllShapes?: () => IShapeAnnotation[];
        getDeletedEmbeddedShapeAnnotationIds?: () => string[];
        getDeletedEmbeddedShapeStableKeys?: () => string[];
        getMarkupSubtypeOverrides?: () => Map<string, TMarkupSubtype> | undefined;
        getMarkupSubtypeHints?: () => IMarkupSubtypeHint[] | undefined;
        markShapeStateSaved?: IWorkspaceSaveDependencies['shapes']['markSaved'];
        preparePersistedShapeStateForSave?: IWorkspaceSaveDependencies['shapes']['preparePersistedState'];
        restorePreparedPersistedShapeState?: IWorkspaceSaveDependencies['shapes']['restorePreparedState'];
        loadRecentFiles: IWorkspaceSaveDependencies['lifecycle']['loadRecentFiles'];
        preparePostSaveReload?: IWorkspaceSaveDependencies['lifecycle']['preparePostSaveReload'];
        runWithDocumentOperationLease?: NonNullable<IWorkspaceSaveDependencies['runWithDocumentOperationLease']>;
        canonicalAnnotationComments: Ref<IAnnotationCommentSummary[]>;
        captureCanonicalPendingTextUpdates: () => Map<string, string> | null;
        captureCanonicalPendingAnnotationDeletes: () => IAnnotationCommentSummary[] | null;
    };
export type TPdfNativeMutationSave = NonNullable<
    IWorkspaceSaveDependencies['persistence']['trySavePdfNativeMutations']
>;

vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
vi.stubGlobal('useToast', () => ({ add: toastAddMock }));

export function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });
    return {
        promise,
        resolve,
        reject,
    };
}

function createSaveDependencies(
    deps: TFileOperationsSaveControllerTestDeps,
): IWorkspaceSaveDependencies {
    const unencryptedSaveNotice = deps.requestUnencryptedSaveNotice
        ? {
            request: deps.requestUnencryptedSaveNotice,
            suppress: deps.suppressUnencryptedSaveNotice ?? ref(false),
            updateSuppress: deps.updateSuppressUnencryptedSaveNotice ?? (() => undefined),
            resetSuppress: deps.resetSuppressUnencryptedSaveNotice ?? (() => undefined),
            flushSettings: deps.flushSettings ?? (async () => true),
        }
        : undefined;

    return {
        status: deps,
        document: {
            sessionKey: deps.documentSessionKey,
            workingCopyPath: deps.workingCopyPath,
            originalPath: deps.originalPath,
            revisionToken: deps.documentRevisionToken,
            ...(deps.wasEncrypted ? {wasEncrypted: deps.wasEncrypted} : {}),
        },
        ...(unencryptedSaveNotice ? {unencryptedSaveNotice} : {}),
        annotations: {
            dirty: deps.annotationDirty,
            markSaved: deps.markAnnotationSaved,
            ...(deps.getAnnotationSaveStateToken
                ? {getSaveStateToken: deps.getAnnotationSaveStateToken}
                : {}),
            hasChanges: deps.hasAnnotationChanges,
            ...(deps.hasPendingAnnotationDeletes
                ? {hasPendingDeletes: deps.hasPendingAnnotationDeletes}
                : {}),
            openNoteCount: deps.annotationNoteWindowsCount,
            persistOpenNotes: deps.persistAllAnnotationNotes,
        },
        metadata: {
            totalPages: deps.totalPages,
            pageLabelsDirty: deps.pageLabelsDirty,
            pageLabelRanges: deps.pageLabelRanges,
            bookmarksDirty: deps.bookmarksDirty,
            bookmarkItems: deps.bookmarkItems,
            untitledBookmarkLabel: deps.untitledBookmarkLabel,
            markPageLabelsSaved: deps.markPageLabelsSaved,
            ...(deps.getPageLabelsSaveStateToken
                ? {getPageLabelsSaveStateToken: deps.getPageLabelsSaveStateToken}
                : {}),
            markBookmarksSaved: deps.markBookmarksSaved,
            ...(deps.getBookmarksSaveStateToken
                ? {getBookmarksSaveStateToken: deps.getBookmarksSaveStateToken}
                : {}),
        },
        pdf: {
            document: deps.pdfDocument,
            ...(deps.commitPdfEditorsForSave
                ? {commitEditorsForSave: deps.commitPdfEditorsForSave}
                : {}),
            runSaveTransaction: deps.runSaveTransaction,
            getSourceData: deps.getSourcePdfData,
            serializeForSave: deps.serializePdfForSave,
        },
        persistence: {
            validatePdfPath: deps.validatePdfPath,
            saveSerialized: deps.saveFile,
            saveWorkingCopy: deps.saveWorkingCopy,
            saveAs: deps.saveWorkingCopyAs,
            ...(deps.repairWorkingCopy ? {repairWorkingCopy: deps.repairWorkingCopy} : {}),
            ...(deps.optimizeWorkingCopy ? {optimizeWorkingCopy: deps.optimizeWorkingCopy} : {}),
            ...(deps.optimizeWorkingCopyAsCopy
                ? {optimizeWorkingCopyAsCopy: deps.optimizeWorkingCopyAsCopy}
                : {}),
            ...(deps.trySavePdfNativeMutations
                ? {trySavePdfNativeMutations: deps.trySavePdfNativeMutations}
                : {}),
            ...(deps.trySaveEmbeddedNoteTextUpdates
                ? {trySaveEmbeddedNoteTextUpdates: deps.trySaveEmbeddedNoteTextUpdates}
                : {}),
            ...(deps.getWorkingCopySize
                ? {getWorkingCopySize: deps.getWorkingCopySize}
                : {}),
        },
        shapes: {
            hasChanges: () => deps.hasShapeChanges?.() ?? false,
            hasManagedShapes: () => deps.hasManagedShapes?.() ?? false,
            ...(deps.markShapeStateSaved ? {markSaved: deps.markShapeStateSaved} : {}),
            ...(deps.preparePersistedShapeStateForSave
                ? {preparePersistedState: deps.preparePersistedShapeStateForSave}
                : {}),
            ...(deps.restorePreparedPersistedShapeState
                ? {restorePreparedState: deps.restorePreparedPersistedShapeState}
                : {}),
        },
        lifecycle: {
            loadRecentFiles: deps.loadRecentFiles,
            ...(deps.preparePostSaveReload
                ? {preparePostSaveReload: deps.preparePostSaveReload}
                : {}),
        },
        ...(deps.runWithDocumentOperationLease
            ? {runWithDocumentOperationLease: deps.runWithDocumentOperationLease}
            : {}),
    };
}

export function useWorkspaceSaveServiceForTest(deps: TFileOperationsSaveControllerTestDeps) {
    const service = useWorkspaceSaveService(createSaveDependencies(deps));
    return {
        ...service,
        handleSaveAs: () => service.handleSaveAs(
            deps.optimizePdfOnSaveAs?.value === true,
        ),
    };
}

function canonicalEntityFromSummary(
    summary: IAnnotationCommentSummary,
    pendingTexts: ReadonlyMap<string, string>,
    deleted = false,
): AnnotationEntity {
    const id = summary.appAnnotationId
        ? asAnnotationId(summary.appAnnotationId)
        : deriveAnnotationId('save-controller-fixture', summary.stableKey);
    const identity = {
        id,
        ...(summary.annotationId ? {pdfRef: summary.annotationId} : {}),
    };
    const text = pendingTexts.get(summary.stableKey) ?? summary.text;
    const common = {
        identity,
        pageIndex: summary.pageIndex,
        revision: 1,
        persistedRevision: 0,
        deleted,
        createdAt: summary.createdAt ?? null,
        modifiedAt: summary.modifiedAt ?? null,
        author: summary.author ?? null,
    } as const;
    if (
        summary.subtype === 'Highlight'
        || summary.subtype === 'Underline'
        || summary.subtype === 'Squiggly'
        || summary.subtype === 'StrikeOut'
    ) {
        return {
            ...common,
            kind: 'text-markup',
            subtype: summary.subtype,
            contents: text,
            quadPoints: summary.markerRect ? [summary.markerRect] : [],
            color: summary.color ?? null,
            opacity: summary.opacity ?? null,
        };
    }
    if (summary.subtype === 'FreeText' || summary.subtype === 'Typewriter') {
        return {
            ...common,
            kind: 'text-box',
            text,
            rect: summary.markerRect ?? {
                left: 0.1,
                top: 0.1,
                width: 0.0016,
                height: 0.0016,
            },
            rotation: 0,
            fontSize: 16,
            color: summary.color ?? null,
        };
    }
    return {
        ...common,
        kind: 'note',
        contents: text,
        position: summary.markerRect ?? {
            left: 0.1,
            top: 0.1,
            width: 0.0016,
            height: 0.0016,
        },
        color: summary.color ?? null,
        open: false,
    };
}

function buildCanonicalAnnotationPlan(deps: TFileOperationsSaveControllerTestDeps) {
    const pendingTexts = deps.captureCanonicalPendingTextUpdates() ?? new Map<string, string>();
    const pendingDeletes = deps.captureCanonicalPendingAnnotationDeletes() ?? [];
    const live = deps.canonicalAnnotationComments.value.map(summary => (
        canonicalEntityFromSummary(summary, pendingTexts)
    ));
    const deleted = pendingDeletes.map(summary => canonicalEntityFromSummary(summary, pendingTexts, true));
    const entities = [
        ...live,
        ...deleted,
    ];
    return buildSerializationPlan({
        documentRevisionToken: deps.documentRevisionToken.value,
        epoch: 1,
        entityBaselineHash: 'save-controller-fixture',
        revisions: new Map(entities.map(entity => [
            entity.identity.id,
            entity.revision,
        ])),
    }, entities, entities);
}

export function createDeps(overrides: Partial<Parameters<typeof useWorkspaceSaveServiceForTest>[0]> = {}) {
    const resetModified = vi.fn();
    const saveFile = vi.fn(async (
        _data: Uint8Array,
        _opts: Parameters<IWorkspaceSaveDependencies['persistence']['saveSerialized']>[1],
    ) => ({
        success: true,
        outPath: '/tmp/work.pdf',
        saveMode: 'rewrite' as const,
        didSaveAs: false,
    }));
    const saveWorkingCopyAs = vi.fn(async (
        _data?: Uint8Array,
        _opts?: Parameters<IWorkspaceSaveDependencies['persistence']['saveAs']>[1],
    ) => ({
        success: true,
        outPath: '/tmp/new.pdf',
        saveMode: 'save_as_rewrite' as const,
        didSaveAs: true,
    }));

    const deps = cast<Parameters<typeof useWorkspaceSaveServiceForTest>[0]>({
        isSaving: ref(false),
        isSavingAs: ref(false),
        // Most service tests exercise renderer fallback. Native-path cases opt
        // into an absolute path explicitly so the strict desktop contract is
        // visible in their setup.
        originalPath: ref(TEST_BROWSER_SOURCE_REF),
        workingCopyPath: ref(TEST_BROWSER_WORKING_COPY_REF),
        documentSessionKey: ref('document-session-1'),
        documentRevisionToken: ref('rev-1'),
        annotationDirty: ref(false),
        canonicalAnnotationComments: ref([]),
        pageLabelsDirty: ref(false),
        pageLabelRanges: ref([]),
        bookmarksDirty: ref(false),
        bookmarkItems: ref([]),
        totalPages: ref(1),
        untitledBookmarkLabel: 'Untitled',
        pdfDocument: shallowRef(cast({ annotationStorage: { resetModified } })),
        getSourcePdfData: vi.fn(async () => new Uint8Array([1])),
        validatePdfPath: vi.fn(async () => ({
            isValid: true,
            tool: 'qpdf' as const,
            errors: [],
            warnings: [],
        })),
        saveFile,
        saveWorkingCopy: vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        })),
        saveWorkingCopyAs,
        markAnnotationSaved: vi.fn(),
        markPageLabelsSaved: vi.fn(),
        markBookmarksSaved: vi.fn(),
        hasAnnotationChanges: vi.fn(() => false),
        hasShapeChanges: vi.fn(() => false),
        serializePdfForSave: vi.fn(async (data: Uint8Array) => new Uint8Array([
            ...data,
            2,
            3,
            6,
            4,
            5,
        ])),
        persistAllAnnotationNotes: vi.fn(async () => true),
        captureCanonicalPendingTextUpdates: vi.fn(() => null),
        captureCanonicalPendingAnnotationDeletes: vi.fn(() => null),
        annotationNoteWindowsCount: ref(0),
        loadRecentFiles: vi.fn(),
        markShapeStateSaved: vi.fn(),
        // Priming succeeds by default: the production call returns a save
        // preparation token, and only that token lets a save mark shapes clean.
        preparePersistedShapeStateForSave: vi.fn(async () => ({prepared: true})),
        restorePreparedPersistedShapeState: vi.fn(async () => undefined),
        adoptPersistedShapeStateForNextReload: vi.fn(),
        clearPendingPersistedShapeStateForNextReload: vi.fn(),
        ...overrides,
    });
    if (!overrides.runSaveTransaction) {
        const hasCanonicalAnnotationPlan = overrides.canonicalAnnotationComments !== undefined
            || overrides.captureCanonicalPendingTextUpdates !== undefined
            || overrides.captureCanonicalPendingAnnotationDeletes !== undefined;
        const transaction = usePdfViewerSaveTransaction({
            getPdfDocument: () => deps.pdfDocument.value,
            ...(hasCanonicalAnnotationPlan
                ? {prepareAnnotationSave: () => ({
                    plan: buildCanonicalAnnotationPlan(deps),
                    verify: vi.fn(async () => undefined),
                    commit: vi.fn(),
                })}
                : {}),
            getMarkupSubtypeOverrides: () => deps.getMarkupSubtypeOverrides?.(),
            getMarkupSubtypeHints: () => deps.getMarkupSubtypeHints?.(),
            getAllShapes: () => deps.getAllShapes?.() ?? [],
            getDeletedEmbeddedShapeAnnotationIds: () => deps.getDeletedEmbeddedShapeAnnotationIds?.() ?? [],
            getDeletedEmbeddedShapeStableKeys: () => deps.getDeletedEmbeddedShapeStableKeys?.() ?? [],
        });
        deps.runSaveTransaction = vi.fn(request => transaction.runSaveTransaction(request));
    }

    return {
        deps,
        resetModified,
        saveFile,
        saveWorkingCopyAs,
    };
}

export function expectWorkspaceSaveNotMarked(deps: ReturnType<typeof createDeps>['deps']) {
    expect(deps.markAnnotationSaved).not.toHaveBeenCalled();
    expect(deps.markPageLabelsSaved).not.toHaveBeenCalled();
    expect(deps.markBookmarksSaved).not.toHaveBeenCalled();
    expect(deps.markShapeStateSaved).not.toHaveBeenCalled();
}

export function createShapeAnnotation(overrides: Partial<IShapeAnnotation> = {}): IShapeAnnotation {
    return {
        id: overrides.id ?? 'shape-1',
        type: overrides.type ?? 'rectangle',
        pageIndex: overrides.pageIndex ?? 0,
        x: overrides.x ?? 0.1,
        y: overrides.y ?? 0.2,
        width: overrides.width ?? 0.3,
        height: overrides.height ?? 0.2,
        color: overrides.color ?? '#336699',
        fillColor: overrides.fillColor ?? '#abcdef',
        opacity: overrides.opacity ?? 0.5,
        strokeWidth: overrides.strokeWidth ?? 3,
        source: overrides.source ?? 'local',
        stableKey: overrides.stableKey ?? 'evb-shape:shape-1',
        createdAt: overrides.createdAt ?? 1781009077000,
        modifiedAt: overrides.modifiedAt ?? 1781009087000,
        ...overrides,
    };
}
