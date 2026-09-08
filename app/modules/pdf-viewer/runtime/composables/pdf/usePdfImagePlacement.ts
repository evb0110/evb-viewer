import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import type { Ref } from 'vue';
import { clamp } from 'es-toolkit/math';
import { computeInitialImagePlacementDimensions } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/computeInitialImagePlacementDimensions';
import type { IImagePlacementDimensions } from '@app/modules/pdf-viewer/engine/pdf-image-placement-sizing/pdfImagePlacementSizingTypes';
import { getInitialImagePlacementRect } from '@app/modules/pdf-viewer/engine/image-placement/getInitialImagePlacementRect';
import type { IImagePlacementTarget } from '@app/modules/pdf-viewer/engine/image-placement/getInitialImagePlacementRect';
import type {
    IPdfImagePlacementDraft,
    IPdfImagePlacementRectUpdate,
    IPdfPlacedImageFinalizePayload,
} from '@app/types/pdfImagePlacement';
import {
    createStaticBrowserImagePreview,
    PDF_IMAGE_PLACEMENT_RESOURCE_LIMITS,
    probeBrowserImageFile,
} from '@app/platform/browser-api/public';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import {
    rotateAnnotationPlacementRect,
    unrotateAnnotationPlacementRect,
} from '@app/modules/pdf-viewer/engine/annotation-editor-geometry/annotationEditorGeometry';

interface IUsePdfImagePlacementOptions {
    viewerContainer: Ref<HTMLElement | null>;
    currentPage: Ref<number>;
    numPages: Ref<number>;
    effectiveScale: Ref<number>;
    viewRotation?: Ref<number>;
    getPageDimensions?: (pageNumber: number) => {
        width: number;
        height: number
    } | null;
    // The editor session owns the placement transaction and reports whether
    // the draft can be released.
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
    finalizePlacement: (payload: IPdfPlacedImageFinalizePayload) => void | boolean | Promise<boolean>;
    probeImage?: typeof probeBrowserImageFile;
    createPreview?: typeof createStaticBrowserImagePreview;
}

function resolveDevicePixelRatio() {
    return typeof window !== 'undefined' && window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : 1;
}

const MIN_PLACED_IMAGE_TARGET_LONG_EDGE_PX = 64;
const MIN_PLACED_IMAGE_TARGET_SHORT_EDGE_PX = 16;

function resolvePlacedImageTargetPixels(options: {
    width: number;
    height: number;
}) {
    const requestedWidth = Math.max(1, Math.round(options.width));
    const requestedHeight = Math.max(1, Math.round(options.height));
    const longEdge = Math.max(requestedWidth, requestedHeight);
    const shortEdge = Math.min(requestedWidth, requestedHeight);
    const scaleFactor = Math.max(
        1,
        MIN_PLACED_IMAGE_TARGET_LONG_EDGE_PX / longEdge,
        MIN_PLACED_IMAGE_TARGET_SHORT_EDGE_PX / shortEdge,
    );

    return {
        width: Math.max(1, Math.round(requestedWidth * scaleFactor)),
        height: Math.max(1, Math.round(requestedHeight * scaleFactor)),
    };
}

function getInitialImagePlacementDimensions(
    imageWidth: number,
    imageHeight: number,
    pageWidthPx: number | null,
    pageHeightPx: number | null,
) {
    if (
        !pageWidthPx
        || !pageHeightPx
        || pageWidthPx <= 0
        || pageHeightPx <= 0
    ) {
        return null;
    }

    if (imageWidth <= 0 || imageHeight <= 0) {
        return null;
    }

    const devicePixelRatioValue = resolveDevicePixelRatio();
    const imageCssWidth = imageWidth / devicePixelRatioValue;
    const imageCssHeight = imageHeight / devicePixelRatioValue;
    return computeInitialImagePlacementDimensions({
        pageWidthPx,
        pageHeightPx,
        imageCssWidth,
        imageCssHeight,
    });
}

function getPageContainer(container: HTMLElement | null, pageNumber: TPageNumber) {
    return container?.querySelector<HTMLElement>(
        `.page_container[data-page="${pageNumber}"]`,
    ) ?? null;
}

function resolvePlacementPageNumber(
    requestedPageNumber: number | null | undefined,
    fallbackPageNumber: number,
    pageCount: number,
) {
    if (!Number.isFinite(requestedPageNumber)) {
        return requirePageNumber(Math.max(1, fallbackPageNumber), pageCount);
    }

    return requirePageNumber(clamp(Math.floor(Number(requestedPageNumber)), 1, pageCount), pageCount);
}

function resolvePlacementCoordinate(value: number | null | undefined) {
    return clamp(Number.isFinite(value) ? Number(value) : 0.5, 0, 1);
}

export const usePdfImagePlacement = (options: IUsePdfImagePlacementOptions) => {
    const {
        viewerContainer,
        currentPage,
        numPages,
        effectiveScale,
        finalizePlacement,
        probeImage = probeBrowserImageFile,
        createPreview = createStaticBrowserImagePreview,
    } = options;

    const pendingImagePlacement = ref<IPdfImagePlacementDraft | null>(null);
    const isPendingImagePlacementFinalizing = ref(false);
    let latestImagePlacementRequestId = 0;
    let imagePlacementAbortController: AbortController | null = null;
    let imageFinalizationAbortController: AbortController | null = null;

    function reprojectPendingPlacement(nextRotation: number) {
        const placement = pendingImagePlacement.value;
        const previousRotation = placement?.viewRotation;
        const dimensions = placement ? options.getPageDimensions?.(placement.pageNumber) : null;
        if (!placement || !dimensions || previousRotation === undefined || previousRotation === nextRotation) {
            return;
        }
        const canonical = unrotateAnnotationPlacementRect({
            left: placement.x,
            top: placement.y,
            width: placement.width,
            height: placement.height,
        }, previousRotation, dimensions);
        const displayed = rotateAnnotationPlacementRect(canonical, nextRotation, dimensions);
        pendingImagePlacement.value = {
            ...placement,
            viewRotation: nextRotation,
            x: displayed.left,
            y: displayed.top,
            width: displayed.width,
            height: displayed.height,
            rotationDegrees: (placement.rotationDegrees + nextRotation - previousRotation + 360) % 360,
        };
    }

    if (options.viewRotation) {
        watch(options.viewRotation, next => reprojectPendingPlacement(next), {flush: 'sync'});
    }

    function revokePendingImagePlacementPreview() {
        const previewUrl = pendingImagePlacement.value?.previewUrl;
        if (previewUrl) {
            URL.revokeObjectURL(previewUrl);
        }
    }

    function clearPendingImagePlacement(options: {invalidatePendingStarts?: boolean;} = {}) {
        if (options.invalidatePendingStarts !== false) {
            latestImagePlacementRequestId += 1;
            imagePlacementAbortController?.abort(new Error('Image placement superseded'));
            imagePlacementAbortController = null;
        }
        imageFinalizationAbortController?.abort();
        imageFinalizationAbortController = null;
        revokePendingImagePlacementPreview();
        pendingImagePlacement.value = null;
        isPendingImagePlacementFinalizing.value = false;
    }

    function restorePendingImagePlacement() {
        if (!pendingImagePlacement.value) {
            return;
        }
        isPendingImagePlacementFinalizing.value = false;
    }

    function getImagePlacementTarget(optionsOverride?: {
        pageNumber?: TPageNumber | null;
        pageX?: number | null;
        pageY?: number | null;
    }): IImagePlacementTarget {
        const container = viewerContainer.value;
        const pageNumber = resolvePlacementPageNumber(
            optionsOverride?.pageNumber,
            currentPage.value,
            numPages.value,
        );
        const pageContainer = getPageContainer(container, pageNumber);
        const pageRect = pageContainer?.getBoundingClientRect() ?? null;

        return {
            pageNumber,
            pageX: resolvePlacementCoordinate(optionsOverride?.pageX),
            pageY: resolvePlacementCoordinate(optionsOverride?.pageY),
            pageWidthPx: pageRect?.width ?? null,
            pageHeightPx: pageRect?.height ?? null,
        };
    }

    async function startImagePlacement(
        file: File,
        optionsOverride?: {
            pageNumber?: TPageNumber | null;
            pageX?: number | null;
            pageY?: number | null;
            appAnnotationId?: string;
            stableKey?: string;
            annotationId?: string | null;
        },
    ) {
        imageFinalizationAbortController?.abort();
        imageFinalizationAbortController = null;
        isPendingImagePlacementFinalizing.value = false;
        const requestId = latestImagePlacementRequestId + 1;
        latestImagePlacementRequestId = requestId;
        imagePlacementAbortController?.abort(new Error('Image placement superseded'));
        const abortController = new AbortController();
        imagePlacementAbortController = abortController;
        const target = getImagePlacementTarget(optionsOverride);
        const initialViewRotation = options.viewRotation?.value ?? 0;
        let initialDimensions: IImagePlacementDimensions | null;
        let bytes: Uint8Array;
        let previewBlob: Blob;
        try {
            const image = await probeImage(
                file,
                PDF_IMAGE_PLACEMENT_RESOURCE_LIMITS,
                abortController.signal,
            );
            initialDimensions = getInitialImagePlacementDimensions(
                image.width,
                image.height,
                target.pageWidthPx,
                target.pageHeightPx,
            );
            bytes = image.bytes;
            previewBlob = await createPreview(image, 2_048, abortController.signal);
            if (!initialDimensions) {
                return false;
            }
            if (requestId !== latestImagePlacementRequestId) {
                return false;
            }

            const previewUrl = URL.createObjectURL(previewBlob);
            const placementRect = getInitialImagePlacementRect(target, initialDimensions);

            clearPendingImagePlacement({ invalidatePendingStarts: false });
            pendingImagePlacement.value = {
                ...(optionsOverride?.appAnnotationId ? {appAnnotationId: optionsOverride.appAnnotationId} : {}),
                stableKey: optionsOverride?.stableKey ?? `placed-image-${crypto.randomUUID()}`,
                ...(optionsOverride?.annotationId ? {annotationId: optionsOverride.annotationId} : {}),
                ...placementRect,
                rotationDegrees: 0,
                viewRotation: initialViewRotation,
                previewUrl,
                fileName: file.name,
                mimeType: file.type || 'image/png',
                bytes,
                ...(image.orientation === undefined ? {} : {sourceOrientation: image.orientation}),
                sourceFrameCount: image.frameCount,
                sourcePixelWidth: image.width,
                sourcePixelHeight: image.height,
            };
            reprojectPendingPlacement(options.viewRotation?.value ?? 0);
            isPendingImagePlacementFinalizing.value = false;
            return true;
        } catch (error) {
            logPdfRenderTrace('pdf-image-placement-start-failed', {
                error: error instanceof Error ? error.message : String(error),
                fileName: file.name,
                fileType: file.type,
                pageNumber: target.pageNumber,
                requestId,
            });
            return false;
        } finally {
            if (imagePlacementAbortController === abortController) {
                imagePlacementAbortController = null;
            }
        }
    }

    function updatePendingImagePlacementRect(update: IPdfImagePlacementRectUpdate) {
        if (!pendingImagePlacement.value) {
            return;
        }

        pendingImagePlacement.value = {
            ...pendingImagePlacement.value,
            ...update,
        };
    }

    function getPendingImagePlacementTargetPixels(placement: IPdfImagePlacementDraft) {
        const pageContainer = getPageContainer(
            viewerContainer.value,
            requirePageNumber(placement.pageNumber, numPages.value),
        );
        const canvas = pageContainer?.querySelector<HTMLCanvasElement>('.page_canvas canvas') ?? null;
        const devicePixelRatioValue = resolveDevicePixelRatio();
        const renderedPagePixelWidth = canvas?.width
            ?? Math.max(1, Math.round((pageContainer?.clientWidth ?? 1) * devicePixelRatioValue));
        const renderedPagePixelHeight = canvas?.height
            ?? Math.max(1, Math.round((pageContainer?.clientHeight ?? 1) * devicePixelRatioValue));
        const renderScale = effectiveScale.value > 0 ? effectiveScale.value : 1;
        const basePagePixelWidth = Math.max(1, Math.round(renderedPagePixelWidth / renderScale));
        const basePagePixelHeight = Math.max(1, Math.round(renderedPagePixelHeight / renderScale));

        return resolvePlacedImageTargetPixels({
            width: placement.width * basePagePixelWidth,
            height: placement.height * basePagePixelHeight,
        });
    }

    function requestPendingImagePlacementFinalize() {
        const placement = pendingImagePlacement.value;
        if (!placement || isPendingImagePlacementFinalizing.value) {
            return;
        }

        const targetPixels = getPendingImagePlacementTargetPixels(placement);
        const placementRequestId = latestImagePlacementRequestId;
        const finalizationAbortController = new AbortController();
        imageFinalizationAbortController = finalizationAbortController;
        isPendingImagePlacementFinalizing.value = true;
        // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
        let result: void | boolean | Promise<boolean>;
        try {
            result = finalizePlacement({
                viewRotation: placement.viewRotation,
                signal: finalizationAbortController.signal,
                ...(placement.appAnnotationId ? {appAnnotationId: placement.appAnnotationId} : {}),
                ...(placement.stableKey ? {stableKey: placement.stableKey} : {}),
                ...(placement.annotationId ? {annotationId: placement.annotationId} : {}),
                pageNumber: placement.pageNumber,
                x: placement.x,
                y: placement.y,
                width: placement.width,
                height: placement.height,
                rotationDegrees: placement.rotationDegrees,
                fileName: placement.fileName,
                mimeType: placement.mimeType,
                bytes: placement.bytes.slice(),
                ...(placement.sourceOrientation === undefined ? {} : {sourceOrientation: placement.sourceOrientation}),
                ...(placement.sourceFrameCount === undefined ? {} : {sourceFrameCount: placement.sourceFrameCount}),
                sourcePixelWidth: placement.sourcePixelWidth,
                sourcePixelHeight: placement.sourcePixelHeight,
                targetPixelWidth: targetPixels.width,
                targetPixelHeight: targetPixels.height,
            });
        } catch (error) {
            restorePendingImagePlacement();
            throw error;
        }
        if (result instanceof Promise) {
            void result.then(success => {
                if (latestImagePlacementRequestId !== placementRequestId) {
                    return;
                }
                if (success) {
                    clearPendingImagePlacement();
                } else {
                    restorePendingImagePlacement();
                }
            }).catch(() => {
                if (latestImagePlacementRequestId !== placementRequestId) {
                    return;
                }
                restorePendingImagePlacement();
            });
            return;
        }
        if (result === false) {
            restorePendingImagePlacement();
            return;
        }
        clearPendingImagePlacement();
    }

    onScopeDispose(() => {
        clearPendingImagePlacement();
    });

    return {
        pendingImagePlacement,
        isPendingImagePlacementFinalizing,
        startImagePlacement,
        updatePendingImagePlacementRect,
        requestPendingImagePlacementFinalize,
        clearPendingImagePlacement,
        restorePendingImagePlacement,
    };
};
