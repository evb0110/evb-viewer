import type {
    IPdfOptimizeOptions,
    IPdfOptimizeProgress,
    IPdfOptimizeResult,
    TPdfOptimizePreset,
} from '@contracts/electronApiDocuments';
import { createRequestId } from '@contracts/shared';
import type { TRequestId } from '@contracts/shared';
import { getDocumentMenuCapability } from '@app/utils/platformDocuments';
import { formatBytes } from '@app/utils/formatters';

interface IUseDocumentWorkspaceOptimizeDialogOptions {handleOptimizePdfAsCopy: (
    options: IPdfOptimizeOptions,
    requestId: TRequestId,
    onResult: (result: IPdfOptimizeResult) => void,
) => Promise<boolean>;}

export const useDocumentWorkspaceOptimizeDialog = ({handleOptimizePdfAsCopy}: IUseDocumentWorkspaceOptimizeDialogOptions) => {
    const { t } = useTypedI18n();
    const toast = useToast();
    const optimizeDialogOpen = ref(false);
    const optimizeProgress = ref<IPdfOptimizeProgress | null>(null);
    const optimizeRequestId = ref<TRequestId | null>(null);
    const optimizeNotice = ref<{
        preset: TPdfOptimizePreset;
        message: string;
    } | null>(null);
    const isOptimizeDialogRunning = computed(() => optimizeRequestId.value !== null);

    function createOptimizeRequestId() {
        return createRequestId('pdf-optimize');
    }

    function openOptimizePdfForInteractionDialog() {
        optimizeProgress.value = null;
        optimizeNotice.value = null;
        optimizeDialogOpen.value = true;
        return true;
    }

    function handleOptimizeDialogOpenChange(value: boolean) {
        if (!value && isOptimizeDialogRunning.value) {
            return;
        }

        optimizeDialogOpen.value = value;
        if (value) {
            optimizeProgress.value = null;
            optimizeNotice.value = null;
        }
    }

    function describeSizes(result: IPdfOptimizeResult) {
        if (result.originalBytes === null || result.optimizedBytes === null) {
            return undefined;
        }
        return {
            original: formatBytes(result.originalBytes),
            optimized: formatBytes(result.optimizedBytes),
            percent: Math.max(1, Math.round((1 - result.optimizedBytes / result.originalBytes) * 100)),
        };
    }

    async function handleOptimizeDialogSubmit(options: IPdfOptimizeOptions) {
        if (isOptimizeDialogRunning.value) {
            return;
        }

        const requestId = createOptimizeRequestId();
        optimizeRequestId.value = requestId;
        optimizeNotice.value = null;
        optimizeProgress.value = {
            requestId,
            preset: options.preset,
            phase: 'preparing',
            processed: 0,
            total: 1,
            percent: 0,
        };

        const reported: {result: IPdfOptimizeResult | null;} = {result: null};
        const success = await handleOptimizePdfAsCopy(options, requestId, (result) => {
            reported.result = result;
        });
        const result = reported.result;
        const sizes = result === null ? undefined : describeSizes(result);
        if (success) {
            optimizeDialogOpen.value = false;
            toast.add({
                color: 'success',
                title: t('optimizePdf.successTitle'),
                ...(sizes ? {description: t('optimizePdf.savedDescription', sizes)} : {}),
            });
        } else {
            // A copy that would not be smaller is not written; the dialog says
            // so and stays open for another preset. Other refusals were already
            // reported by the save surface.
            optimizeProgress.value = null;
            if (result?.outcome === 'not-smaller' && sizes) {
                optimizeNotice.value = {
                    preset: options.preset,
                    message: t('optimizePdf.notSmaller', sizes),
                };
            }
        }

        optimizeRequestId.value = null;
    }

    let unsubscribeProgress: (() => void) | null = null;
    onMounted(() => {
        unsubscribeProgress = getDocumentMenuCapability().onPdfOptimizeProgress((progress) => {
            if (progress.requestId === optimizeRequestId.value) {
                optimizeProgress.value = progress;
            }
        });
    });
    onBeforeUnmount(() => unsubscribeProgress?.());

    return {
        handleOptimizeDialogOpenChange,
        handleOptimizeDialogSubmit,
        isOptimizeDialogRunning,
        openOptimizePdfForInteractionDialog,
        optimizeDialogOpen,
        optimizeNotice,
        optimizeProgress,
    };
};
