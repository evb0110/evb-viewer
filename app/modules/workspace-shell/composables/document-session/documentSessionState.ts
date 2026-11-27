import type {ComputedRef, Ref, ShallowRef} from 'vue';
import type {TDocumentRef} from '@contracts/documentRef';
import type {IDocumentRevisionInfo, TDocumentRevisionToken} from '@contracts/documentRevision';
import type {IFailurePresentation} from '@app/composables/useFailureToast';
import type {TPdfSource} from '@app/types/pdfUi';
import type {TPdfRasterDisplayProfile} from '@app/types/pdfRasterDisplayProfile';
import type {IPdfConformanceProfile, TPdfSaveMode} from '@app/types/pdfContracts';
import type {IWorkspaceDocumentController} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type {IPdfSourceJob, TPdfSourceJobIntent} from '@app/modules/pdf-viewer/public';
import {getDocumentRefBaseName} from '@app/utils/documentRef';

export type TPdfConformanceAnalysisState =
    'none' | 'waiting-initial-visual' | 'waiting-idle' | 'analyzing' | 'ready' | 'failed' | 'on-demand-only';

/** The record the file session reads and writes: its document controller's. */
export type TDocumentFileRecord = Pick<IWorkspaceDocumentController, 'file' | 'commitFile' | 'snapshot' | 'setOpeningLabel'>;

/**
 * The file session's state. Where the document lives and which revision it
 * holds are views of the controller's record; the rest is the loaded source.
 */
export interface IDocumentSessionState {
    commitFile: TDocumentFileRecord['commitFile'];
    error: Ref<string | null>;
    failurePresentation: Ref<IFailurePresentation | null>;
    fileName: ComputedRef<string | null>;
    isDirty: Ref<boolean>;
    isElectron: ComputedRef<boolean>;
    lastSaveMode: Ref<TPdfSaveMode>;
    originalPath: Ref<TDocumentRef | null>;
    pdfConformanceAnalysisState: Ref<TPdfConformanceAnalysisState>;
    pdfConformanceProfile: Ref<IPdfConformanceProfile | null>;
    pdfData: ShallowRef<Uint8Array | null>;
    pdfRasterDisplayProfile: Ref<TPdfRasterDisplayProfile | null>;
    pdfReloadSrc: Ref<TPdfSource | null>;
    pdfSrc: Ref<TPdfSource | null>;
    /** The one place the PDF source is published; returns the job its views load. */
    publishPdfSource: (source: TPdfSource | null, intent: TPdfSourceJobIntent) => IPdfSourceJob;
    pendingDjvu: Ref<TDocumentRef | null>;
    /** True only after the current document completed a password-protected open. */
    wasEncrypted: Ref<boolean>;
    requiresSaveAsOnFirstSave: Ref<boolean>;
    /** Unsaved bytes adopted from a crash checkpoint, independent of Save As. */
    recoveryDirtyBaseline: Ref<boolean>;
    workingCopyPath: Ref<TDocumentRef | null>;
    /** The working copy the document was opened at: a Save As moves the working copy, not this. */
    openedWorkingCopyPath: Ref<TDocumentRef | null>;
    /** Writing a full stamp also adopts its token. */
    documentRevisionInfo: Ref<IDocumentRevisionInfo | null>;
    documentRevisionToken: Ref<TDocumentRevisionToken | null>;
    isActiveWorkingCopy: (path: TDocumentRef) => boolean;
    resetForClose: () => void;
}

export function createDocumentSessionState(deps: {
    isDesktopRuntime: Ref<boolean> | ComputedRef<boolean>;
    document: TDocumentFileRecord;
    admitPdfSource: (intent: TPdfSourceJobIntent) => IPdfSourceJob;
}): IDocumentSessionState {
    const {file, commitFile} = deps.document;
    const originalPath = computed({
        get: () => file.value.originalPath,
        set: (path: TDocumentRef | null) => commitFile({originalPath: path}),
    });
    const workingCopyPath = computed({
        get: () => file.value.workingCopyPath,
        set: (path: TDocumentRef | null) => commitFile({workingCopyPath: path}),
    });
    const documentRevisionInfo = computed({
        get: () => file.value.revisionInfo,
        set: (revisionInfo: IDocumentRevisionInfo | null) =>
            commitFile({
                revisionInfo,
                revisionToken: revisionInfo?.token ?? null,
            }),
    });
    const documentRevisionToken = computed({
        get: () => file.value.revisionToken,
        set: (revisionToken: TDocumentRevisionToken | null) => commitFile({revisionToken}),
    });
    const pdfSrc = shallowRef<TPdfSource | null>(null);
    const pdfReloadSrc = shallowRef<TPdfSource | null>(null);
    const pdfData = shallowRef<Uint8Array | null>(null);
    const pdfRasterDisplayProfile = ref<TPdfRasterDisplayProfile | null>(null);
    const openedWorkingCopyPath = ref<TDocumentRef | null>(null);
    const error = ref<string | null>(null);
    const failurePresentation = shallowRef<IFailurePresentation | null>(null);
    const isDirty = ref(false);
    const pdfConformanceAnalysisState = ref<TPdfConformanceAnalysisState>('none');
    const pdfConformanceProfile = ref<IPdfConformanceProfile | null>(null);
    const lastSaveMode = ref<TPdfSaveMode>('rewrite');
    const requiresSaveAsOnFirstSave = ref(false);
    const recoveryDirtyBaseline = ref(false);
    const wasEncrypted = ref(false);
    const pendingDjvu = ref<TDocumentRef | null>(null);

    function publishPdfSource(source: TPdfSource | null, intent: TPdfSourceJobIntent) {
        pdfSrc.value = source;
        pdfReloadSrc.value = source;
        return deps.admitPdfSource(intent);
    }

    function resetForClose() {
        publishPdfSource(null, 'clear');
        pdfData.value = null;
        pdfRasterDisplayProfile.value = null;
        openedWorkingCopyPath.value = null;
        commitFile({
            originalPath: null,
            workingCopyPath: null,
            revisionInfo: null,
            revisionToken: null,
            isDjvu: false,
        });
        error.value = null;
        failurePresentation.value = null;
        isDirty.value = false;
        pdfConformanceAnalysisState.value = 'none';
        pendingDjvu.value = null;
        deps.document.setOpeningLabel(null);
        requiresSaveAsOnFirstSave.value = false;
        recoveryDirtyBaseline.value = false;
        wasEncrypted.value = false;
        lastSaveMode.value = 'rewrite';
    }

    return {
        commitFile,
        error,
        failurePresentation,
        fileName: computed(() => getDocumentRefBaseName(originalPath.value) ?? getDocumentRefBaseName(workingCopyPath.value)),
        isDirty,
        isElectron: computed(() => deps.isDesktopRuntime.value),
        isActiveWorkingCopy: (path) => workingCopyPath.value === path,
        lastSaveMode,
        originalPath,
        pdfConformanceAnalysisState,
        pdfConformanceProfile,
        pdfData,
        pdfRasterDisplayProfile,
        pdfReloadSrc,
        pdfSrc,
        publishPdfSource,
        pendingDjvu,
        requiresSaveAsOnFirstSave,
        recoveryDirtyBaseline,
        wasEncrypted,
        resetForClose,
        workingCopyPath,
        openedWorkingCopyPath,
        documentRevisionInfo,
        documentRevisionToken,
    };
}
