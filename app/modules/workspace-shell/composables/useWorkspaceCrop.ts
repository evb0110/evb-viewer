import type { Ref } from 'vue';
import type {
    ICropMargins,
    IPageGeometry,
} from '@app/types/crop';
import type { TDocumentRef } from '@contracts/documentRef';
import { requirePageNumber } from '@contracts/pageNumbers';
import { screenRectToMargins } from '@app/utils/pdfCropCoordinates';
import { resolvePdfPageViewportRotation } from '@app/utils/pdfViewRotation';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { IWorkspacePdfViewerCropPort } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import { getPageOpsCapability } from '@app/utils/platformDocuments';
import { getErrorMessage } from '@app/utils/error';

interface IUseWorkspaceCropOptions {
    pdfViewerRef: Ref<IWorkspacePdfViewerCropPort | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
}

export const useWorkspaceCrop = (options: IUseWorkspaceCropOptions) => {
    const cropDialogOpen = ref(false);
    const cropDialogLoading = ref(false);
    const cropDialogMargins = ref<ICropMargins>({
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
    });
    const cropDialogMediaBox = ref({
        x: 0,
        y: 0,
        width: 612,
        height: 792,
    });
    const cropDialogCurrentBox = ref<IPageGeometry['cropBox']>(null);
    const cropDialogPageNumber = ref(1);
    const cropDialogRotation = ref(0);
    let cropRequestToken = 0;

    const isCropSelecting = computed(() => options.pdfViewerRef.value?.isCropSelecting ?? false);

    function isCurrentCropRequest(
        requestToken: number,
        viewer: IWorkspacePdfViewerCropPort,
        workingCopyPath: TDocumentRef,
    ) {
        return requestToken === cropRequestToken
            && options.pdfViewerRef.value === viewer
            && options.workingCopyPath.value === workingCopyPath;
    }

    async function handleCrop() {
        const viewer = options.pdfViewerRef.value;
        const workingCopyPath = options.workingCopyPath.value;
        if (!viewer || !workingCopyPath) {
            return;
        }

        if (viewer.isCropSelecting) {
            viewer.cancelCropSelection();
            return;
        }

        cropRequestToken += 1;
        const requestToken = cropRequestToken;
        const result = await viewer.startCropSelection();
        if (!result || !isCurrentCropRequest(requestToken, viewer, workingCopyPath)) {
            return;
        }

        cropDialogCurrentBox.value = null;
        cropDialogPageNumber.value = result.pageNumber;
        cropDialogRotation.value = 0;
        cropDialogOpen.value = false;
        cropDialogLoading.value = true;

        let geometry: IPageGeometry | null = null;
        try {
            geometry = await getPageOpsCapability().getPageGeometry(
                workingCopyPath,
                requirePageNumber(result.pageNumber),
            );
        } catch (error) {
            BrowserLogger.warn('crop', 'Failed to initialize crop dialog geometry', {
                pageNumber: result.pageNumber,
                path: workingCopyPath,
                error: getErrorMessage(error),
            });
            if (requestToken === cropRequestToken) {
                cropDialogLoading.value = false;
            }
            return;
        }

        if (!isCurrentCropRequest(requestToken, viewer, workingCopyPath)) {
            if (requestToken === cropRequestToken) {
                cropDialogLoading.value = false;
            }
            return;
        }

        const effectiveBox = geometry.cropBox ?? geometry.mediaBox;
        // The selection was drawn under the view's rotation as well as the page's.
        const displayRotation = resolvePdfPageViewportRotation(geometry.rotation, result.viewRotation);
        const margins = screenRectToMargins(
            result.pageLocalRect,
            {
                left: 0,
                top: 0,
                width: result.pageRect.width,
                height: result.pageRect.height,
            },
            effectiveBox,
            geometry.mediaBox,
            displayRotation,
        );

        cropDialogMargins.value = margins;
        cropDialogMediaBox.value = geometry.mediaBox;
        cropDialogCurrentBox.value = geometry.cropBox;
        cropDialogRotation.value = displayRotation;
        await nextTick();
        if (!isCurrentCropRequest(requestToken, viewer, workingCopyPath)) {
            if (requestToken === cropRequestToken) {
                cropDialogLoading.value = false;
            }
            return;
        }
        cropDialogOpen.value = true;
        cropDialogLoading.value = false;
    }

    watch(cropDialogOpen, (isOpen) => {
        if (isOpen) {
            return;
        }

        cropRequestToken += 1;
        cropDialogLoading.value = false;
    });

    return {
        cropDialogOpen,
        cropDialogLoading,
        cropDialogMargins,
        cropDialogMediaBox,
        cropDialogCurrentBox,
        cropDialogPageNumber,
        cropDialogRotation,
        isCropSelecting,
        handleCrop,
    };
};
