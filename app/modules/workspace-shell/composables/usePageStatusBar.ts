import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TPdfSource } from '@app/types/pdfUi';
import type { TDocumentRef } from '@contracts/documentRef';
import { parseDocumentRef } from '@contracts/documentRef';
import {
    getDocumentRefBaseName,
    getDocumentRefDisplayLabel,
    isBrowserDocumentRef,
} from '@app/utils/documentRef';
import { formatBytes } from '@app/utils/formatters';
import { isBrowserExtensionPage } from '@app/utils/isBrowserExtensionPage';
import {
    getDocumentFilesCapability,
    getDocumentWindowCapability,
} from '@app/utils/platformDocuments';
import { isPathPdfSource as isNativePathPdfSource } from '@app/modules/pdf-viewer/public';

type TSaveDotState = 'idle' | 'saving' | 'failed' | 'dirty' | 'clean';
type TReadableRef<T> = ComputedRef<T> | Ref<T>;

interface IPageStatusBarDeps {
    hasDocument: Ref<boolean>;
    pdfSrc: Ref<TPdfSource | null>;
    pdfData: Ref<Uint8Array | null>;
    originalPath: TReadableRef<TDocumentRef | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
    effectiveZoom: Ref<number>;
    knownFileSizeBytes?: TReadableRef<number | null> | undefined;
    isDocumentVisualPending?: Ref<boolean>;
    canSave: Ref<boolean>;
    isAnySaving: Ref<boolean>;
    isHistoryBusy: Ref<boolean>;
    /** Set while the last save attempt on this document failed. */
    hasSaveFailure: TReadableRef<boolean>;
    handleSave: () => Promise<unknown>;
}

export const usePageStatusBar = (deps: IPageStatusBarDeps) => {
    const {
        hasDocument,
        pdfSrc,
        pdfData,
        originalPath,
        workingCopyPath,
        effectiveZoom,
        knownFileSizeBytes,
        isDocumentVisualPending,
        canSave,
        isAnySaving,
        isHistoryBusy,
        hasSaveFailure,
        handleSave,
    } = deps;
    const {
        t,
        locale,
    } = useTypedI18n();
    const documentFiles = getDocumentFilesCapability();
    const statusFileName = computed(() => {
        const path = originalPath.value ?? workingCopyPath.value;
        return getDocumentRefBaseName(path) ?? t('status.noFileOpen');
    });
    const statusFilePath = computed(() => {
        const path = originalPath.value ?? workingCopyPath.value;
        return getDocumentRefDisplayLabel(path) ?? t('status.noFileOpen');
    });
    const statusShowInFolderPath = computed(() => {
        const path = originalPath.value ?? workingCopyPath.value;
        if (typeof path !== 'string') {
            return null;
        }

        const normalizedPath = path.trim();
        return normalizedPath.length > 0 ? parseDocumentRef(normalizedPath) : null;
    });
    const inMemoryFileSizeBytes = computed(() => {
        if (pdfData.value) {
            return pdfData.value.byteLength;
        }
        if (isNativePathPdfSource(pdfSrc.value)) {
            return pdfSrc.value.size;
        }
        return null;
    });
    const measurableFilePath = computed(() => {
        if (isDocumentVisualPending?.value || inMemoryFileSizeBytes.value !== null) {
            return null;
        }
        // Renderer file I/O is authorized only for the adopted managed copy.
        // The original path may intentionally outlive the visual during close
        // so it can label Recent/status UI, but it must never trigger file:stat.
        const path = workingCopyPath.value;
        return typeof path === 'string' && path.trim().length > 0 ? path : null;
    });
    const statFileSizeBytes = ref<number | null>(null);
    watch(measurableFilePath, async (path) => {
        if (!path) {
            statFileSizeBytes.value = null;
            return;
        }
        try {
            const { size } = await documentFiles.statFile(path);
            if (measurableFilePath.value === path) {
                statFileSizeBytes.value = size;
            }
        } catch {
            if (measurableFilePath.value === path) {
                statFileSizeBytes.value = null;
            }
        }
    }, { immediate: true });
    const statusFileSizeBytes = computed(() => (
        inMemoryFileSizeBytes.value
        ?? knownFileSizeBytes?.value
        ?? statFileSizeBytes.value
    ));
    // With no document the metrics describe nothing, so the bar leaves them out.
    const statusFileSizeLabel = computed(() => {
        if (!hasDocument.value) {
            return '';
        }
        if (statusFileSizeBytes.value === null) {
            return t('status.fileSizeUnknown');
        }
        return t('status.fileSizeValue', { size: formatBytes(statusFileSizeBytes.value, {
            t,
            locale: locale.value,
        }) });
    });
    const statusZoomLabel = computed(() => {
        if (!hasDocument.value) {
            return '';
        }
        if (isDocumentVisualPending?.value) {
            return t('status.zoomUnknown');
        }
        return t('status.zoomValue', { zoom: Math.round(effectiveZoom.value * 100) });
    });
    const statusSaveDotState = computed<TSaveDotState>(() => {
        if (!pdfSrc.value) {
            return 'idle';
        }
        if (isAnySaving.value) {
            return 'saving';
        }
        // A failed save outranks the dirty flag: a document can look clean
        // after a rejected save and still hold unwritten changes.
        if (hasSaveFailure.value) {
            return 'failed';
        }
        if (canSave.value) {
            return 'dirty';
        }
        return 'clean';
    });
    const statusSaveDotClass = computed(() => `is-${statusSaveDotState.value}`);
    const statusSaveDotCanSave = computed(() => (
        !!pdfSrc.value
        && (canSave.value || statusSaveDotState.value === 'failed')
        && !isAnySaving.value
        && !isHistoryBusy.value
    ));
    const statusSaveDotTooltip = computed(() => {
        if (statusSaveDotState.value === 'idle') {
            return t('status.noFileOpen');
        }
        if (statusSaveDotState.value === 'saving') {
            return t('status.savingChanges');
        }
        if (statusSaveDotState.value === 'failed') {
            return t('status.saveFailed');
        }
        if (statusSaveDotState.value === 'dirty') {
            return t('status.unsavedChanges');
        }
        return t('status.allSaved');
    });
    const statusSaveDotAriaLabel = computed(() => {
        if (statusSaveDotState.value === 'failed') {
            return t('status.saveFailed');
        }
        if (statusSaveDotState.value === 'dirty') {
            return t('status.saveChanges');
        }
        if (statusSaveDotState.value === 'saving') {
            return t('status.savingChanges');
        }
        if (statusSaveDotState.value === 'clean') {
            return t('status.allSaved');
        }
        return t('status.noFileOpen');
    });
    // A document the browser stores has no folder; the Chrome extension saves
    // it to Downloads and shows it there instead.
    const statusShowsInDownloads = computed(() => isBrowserDocumentRef(statusShowInFolderPath.value) && isBrowserExtensionPage());
    const statusCanShowInFolder = computed(() => {
        const path = statusShowInFolderPath.value;
        return path !== null && (!isBrowserDocumentRef(path) || statusShowsInDownloads.value);
    });
    const statusShowInFolderLabel = computed(() => {
        const path = statusShowInFolderPath.value;
        if (statusShowsInDownloads.value) {
            return t('status.showInDownloads');
        }
        if (statusCanShowInFolder.value) {
            return t('status.showInFolder');
        }
        return path && isBrowserDocumentRef(path)
            ? t('status.showInFolderUnavailableWeb')
            : t('status.noFileOpen');
    });

    async function handleStatusSaveClick() {
        if (!statusSaveDotCanSave.value) {
            return;
        }
        await handleSave();
    }

    async function handleStatusShowInFolderClick() {
        const path = statusShowInFolderPath.value;
        if (!path || !statusCanShowInFolder.value) {
            return;
        }

        try {
            await getDocumentWindowCapability().showItemInFolder(path);
        } catch {
            // Ignore failures; status bar action is best-effort.
        }
    }

    return {
        statusFileName,
        statusFilePath,
        statusFileSizeLabel,
        statusZoomLabel,
        statusCanShowInFolder,
        statusShowInFolderTooltip: statusShowInFolderLabel,
        statusShowInFolderAriaLabel: statusShowInFolderLabel,
        statusSaveDotClass,
        statusSaveDotCanSave,
        statusSaveDotTooltip,
        statusSaveDotAriaLabel,
        handleStatusSaveClick,
        handleStatusShowInFolderClick,
    };
};
