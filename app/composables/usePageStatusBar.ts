import {
    computed,
    type Ref,
} from 'vue';
import type { TTranslateFn } from '@app/i18n/locales';
import { formatBytes } from '@app/utils/formatters';

export interface IPageStatusBarDeps {
    t: TTranslateFn;
    pdfSrc: Ref<unknown>;
    pdfData: Ref<Uint8Array | null>;
    originalPath: Ref<string | null>;
    workingCopyPath: Ref<string | null>;
    zoom: Ref<number>;
    canSave: Ref<boolean>;
    isAnySaving: Ref<boolean>;
    isHistoryBusy: Ref<boolean>;
    handleSave: () => Promise<void>;
}

export const usePageStatusBar = (deps: IPageStatusBarDeps) => {
    const {
        t,
        pdfSrc,
        pdfData,
        originalPath,
        workingCopyPath,
        zoom,
        canSave,
        isAnySaving,
        isHistoryBusy,
        handleSave,
    } = deps;

    const statusFilePath = computed(() => originalPath.value ?? workingCopyPath.value ?? t('status.noFileOpen'));
    const statusFileSizeBytes = computed(() => {
        if (pdfData.value) {
            return pdfData.value.byteLength;
        }
        if (pdfSrc.value && typeof pdfSrc.value === 'object' && 'kind' in (pdfSrc.value as Record<string, unknown>) && (pdfSrc.value as Record<string, unknown>).kind === 'path') {
            return (pdfSrc.value as { size: number }).size;
        }
        return null;
    });
    const statusFileSizeLabel = computed(() => {
        if (statusFileSizeBytes.value === null) {
            return t('status.fileSizeUnknown');
        }
        return t('status.fileSizeValue', { size: formatBytes(statusFileSizeBytes.value) });
    });
    const statusZoomLabel = computed(() => t('status.zoomValue', { zoom: Math.round(zoom.value * 100) }));
    const statusSaveDotState = computed(() => {
        if (!pdfSrc.value) {
            return 'idle';
        }
        if (isAnySaving.value) {
            return 'saving';
        }
        if (canSave.value) {
            return 'dirty';
        }
        return 'clean';
    });
    const statusSaveDotClass = computed(() => `is-${statusSaveDotState.value}`);
    const statusSaveDotCanSave = computed(() => (
        !!pdfSrc.value
        && canSave.value
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
        if (statusSaveDotState.value === 'dirty') {
            return t('status.unsavedChanges');
        }
        return t('status.allSaved');
    });
    const statusSaveDotAriaLabel = computed(() => {
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

    async function handleStatusSaveClick() {
        if (!statusSaveDotCanSave.value) {
            return;
        }
        await handleSave();
    }

    return {
        statusFilePath,
        statusFileSizeLabel,
        statusZoomLabel,
        statusSaveDotClass,
        statusSaveDotCanSave,
        statusSaveDotTooltip,
        statusSaveDotAriaLabel,
        handleStatusSaveClick,
    };
};
