import type {
    IPdfOptimizeOptions,
    IPdfOptimizeProgress,
} from '@contracts/electronApiDocuments';
import { createRequestId } from '@contracts/shared';
import type { TRequestId } from '@contracts/shared';
import type { FailurePresentation } from '@app/composables/useFailureToast';
import { getDocumentMenuCapability } from '@app/utils/platformDocuments';

interface IUseDocumentWorkspaceOptimizeDialogOptions {
    handleOptimizePdfAsCopy: (options: IPdfOptimizeOptions, requestId: TRequestId) => Promise<boolean>;
    getLastFailurePresentation: () => FailurePresentation | null;
}

export const useDocumentWorkspaceOptimizeDialog = ({
    getLastFailurePresentation,
    handleOptimizePdfAsCopy,
}: IUseDocumentWorkspaceOptimizeDialogOptions) => {
    const { t } = useTypedI18n();
    const toast = useToast();
    const optimizeDialogOpen = ref(false);
    const optimizeProgress = ref<IPdfOptimizeProgress | null>(null);
    const optimizeDialogError = ref<FailurePresentation | null>(null);
    const optimizeRequestId = ref<TRequestId | null>(null);
    const isOptimizeDialogRunning = computed(() => optimizeRequestId.value !== null);

    function createOptimizeRequestId() {
        return createRequestId('pdf-optimize');
    }

    function openOptimizePdfForInteractionDialog() {
        optimizeDialogError.value = null;
        optimizeProgress.value = null;
        optimizeDialogOpen.value = true;
        return true;
    }

    function handleOptimizeDialogOpenChange(value: boolean) {
        if (!value && isOptimizeDialogRunning.value) {
            return;
        }

        optimizeDialogOpen.value = value;
        if (value) {
            optimizeDialogError.value = null;
            optimizeProgress.value = null;
        }
    }

    async function handleOptimizeDialogSubmit(options: IPdfOptimizeOptions) {
        if (isOptimizeDialogRunning.value) {
            return;
        }

        const requestId = createOptimizeRequestId();
        optimizeRequestId.value = requestId;
        optimizeDialogError.value = null;
        optimizeProgress.value = {
            requestId,
            preset: options.preset,
            phase: 'preparing',
            processed: 0,
            total: 1,
            percent: 0,
        };

        const success = await handleOptimizePdfAsCopy(options, requestId);
        if (success) {
            optimizeDialogOpen.value = false;
            toast.add({
                color: 'success',
                title: t('optimizePdf.successTitle'),
            });
        } else {
            optimizeDialogError.value = getLastFailurePresentation();
            optimizeProgress.value = null;
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
        optimizeDialogError,
        optimizeDialogOpen,
        optimizeProgress,
    };
};
