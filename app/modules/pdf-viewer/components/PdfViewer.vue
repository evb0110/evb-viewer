<template>
    <div
        ref="viewerHost"
        class="relative min-h-full w-full"
        data-pdf-viewer-host
        :class="{
            'pdf-viewer-container--dark': props.invertColors === true,
        }"
    >
        <template v-if="props.mountPresentation !== false">
            <PdfViewerViewport
                :set-viewer-container="handleViewerContainerRef"
                :viewer-class="viewerClass"
                :container-style="containerStyle"
                :virtual-page-segments="virtualPageSegments"
                :initial-page-shell="showCommittedInitialPageShell && hasProjectedOpeningPageFrame"
                :initial-page-shell-page="committedInitialPageNumber"
                :opening-page-frame-page="hasProjectedOpeningPageFrame ? committedInitialPageNumber : null"
                :opening-page-frame-style="hasProjectedOpeningPageFrame ? projectedOpeningPageStyle : null"
                :should-show-skeleton="shouldShowViewportPageSkeleton"
                :is-page-render-failed="isPageRenderFailed"
                :page-render-error-label="t('errors.file.open')"
                :is-spread-single="isSpreadSingle"
                :is-buffered-page="isPageBuffered"
                :is-rendered-page="isPageRenderedForClass"
                :get-page-scale="getPageScale"
                :get-page-placeholder-style="getPagePlaceholderStyle"
                :bottom-virtual-spacer-style="bottomVirtualSpacerStyle"
                :pending-image-placement="pendingImagePlacement"
                :is-pending-image-placement-finalizing="isPendingImagePlacementFinalizing"
                @scroll="handleViewportScroll"
                @wheel="handleViewerWheel"
                @mousedown="handleViewerMouseDown"
                @mousemove="handleViewerMouseMove"
                @mouseup="handleViewerMouseUp"
                @mouseleave="handleViewerMouseLeave"
                @click="handleViewerClick"
                @dblclick="handleViewerDblClick"
                @contextmenu="handleViewerContextMenu"
                @selectstart="handleSelectStart"
                @page-container-mounted="handleOpeningPageContainerMounted"
                @page-container-unmounted="handleOpeningPageContainerUnmounted"
                @update-placed-image-rect="updatePendingImagePlacementRect"
                @finalize-placed-image="requestPendingImagePlacementFinalize"
                @cancel-placed-image="clearPendingImagePlacement"
            />
            <PdfInitialSurfacePlaceholder
                v-if="showInitialSurfacePlaceholder"
                :page-style="initialSurfacePlaceholderPageStyle"
            />
            <PdfRegionSnipOverlay
                :active="regionSnip.isActive.value"
                :selection-rect="regionSnip.selectionRect.value"
                :flash-rect="regionSnip.flashRect.value"
                :badge-position="regionSnip.badgePosition.value"
                :hint-label="t('toolbar.captureHint')"
                :copied-label="t('toolbar.captureCopied')"
                @pointer-start="regionSnip.onPointerStart"
                @pointer-move="regionSnip.onPointerMove"
                @pointer-end="regionSnip.onPointerEnd"
                @cancel="regionSnip.cancelCapture"
            />
            <PdfCropOverlay
                :active="cropSelection.isSelecting.value"
                :selection-rect="cropSelection.selectionRect.value"
                :hint-label="t('toolbar.cropHint')"
                @pointer-start="cropSelection.onPointerStart"
                @pointer-move="cropSelection.onPointerMove"
                @pointer-end="cropSelection.onPointerEnd"
                @cancel="cropSelection.cancelSelection"
            />
            <PdfViewerPortalLayers
                :viewer-container="viewerContainer"
                :links-by-page="visibleLinksByPage"
                @link-destination="handleLinkDestination"
            />
        </template>
    </div>
</template>

<script setup lang="ts">
import PdfViewerPortalLayers from '@app/modules/pdf-viewer/components/PdfViewerPortalLayers.vue';
import PdfViewerViewport from '@app/modules/pdf-viewer/components/PdfViewerViewport.vue';
import PdfRegionSnipOverlay from '@app/modules/pdf-viewer/components/PdfRegionSnipOverlay.vue';
import PdfCropOverlay from '@app/modules/pdf-viewer/components/PdfCropOverlay.vue';
import { PdfInitialSurfacePlaceholder } from '@app/modules/pdf-viewer/public/component-exports/pdfInitialSurfacePlaceholder';
import { buildPdfInitialSurfacePlaceholderStyle } from '@app/modules/pdf-viewer/engine/pdf-initial-surface-placeholder/buildPdfInitialSurfacePlaceholderStyle';
import { buildPdfCommittedOpenPageShellStyle } from '@app/modules/pdf-viewer/engine/pdf-initial-surface-placeholder/buildPdfCommittedOpenPageShellStyle';
import { shouldApplyPdfOpeningPageFrame } from '@app/modules/pdf-viewer/engine/pdf-initial-surface-placeholder/shouldApplyPdfOpeningPageFrame';
import {
    createPdfOpeningPageFrameRecord,
    type IPdfOpeningPageFrameRecord,
} from '@app/modules/pdf-viewer/engine/pdf-initial-surface-placeholder/createPdfOpeningPageFrameRecord';
import * as initialPageSkeletonGeometry from '@app/modules/pdf-viewer/runtime/lifecycle/commitPdfInitialPageSkeletonGeometry';
import { createPdfOpeningPageFrameOwnerId } from '@app/modules/pdf-viewer/runtime/lifecycle/createPdfOpeningPageFrameOwnerId';
import type {
    IPdfViewerProps,
    IPdfViewerEmit,
} from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerComponent.types';
import { usePdfViewerFeatureController } from '@app/modules/pdf-viewer/runtime/usePdfViewerFeatureController';
import {
    createDocumentViewerChassisAuthority,
    injectDocumentViewerChassisAuthority,
} from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import { createDocumentOpenGenerationErrorLatch } from '@app/utils/document-viewer/chassis/createDocumentOpenGenerationErrorLatch';
import { shouldShowPdfViewportPageSkeleton } from '@app/modules/pdf-viewer/runtime/navigation/shouldShowPdfViewportPageSkeleton';

import '@app/assets/css/vendor/pdfjs-viewer-sanitized.css';

const props = defineProps<IPdfViewerProps>();
const injectedChassisAuthority = injectDocumentViewerChassisAuthority();
const chassisAuthority = injectedChassisAuthority
    ?? createDocumentViewerChassisAuthority(ref('pdf'), props.currentPage);
const emitBase = defineEmits<IPdfViewerEmit>();
const openErrorLatch = createDocumentOpenGenerationErrorLatch();
const isCommittedInitialPageTransition = computed(() => {
    const snapshot = chassisAuthority?.openSurface.snapshot.value;
    return snapshot !== undefined
        && (
            snapshot.phase === 'pending'
            || snapshot.phase === 'geometry-committed'
            || snapshot.phase === 'canvas-committed'
            || snapshot.phase === 'viewport-committed'
        );
});
const emit = ((event: string, ...args: unknown[]) => {
    if (event === 'initial-visual-ready') {
        const generation = chassisAuthority.openSurface.snapshot.value.generation;
        if (openErrorLatch.consumeMatchingSuccess(generation)) {
            (emitBase as (event: string, ...args: unknown[]) => void)('load-error', null);
        }
    }
    if (event === 'load-error') {
        const generation = chassisAuthority.openSurface.snapshot.value.generation;
        openErrorLatch.recordFailure(generation);
        chassisAuthority.openSurface.fail(generation, 'PDF viewer load failed');
    }
    (emitBase as (event: string, ...args: unknown[]) => void)(event, ...args);
}) as IPdfViewerEmit;
const controller = usePdfViewerFeatureController(props, emit, chassisAuthority);
const {
    t,
    viewerHost,
    viewerContainer,
    viewerClass,
    containerStyle,
    scaledMargin,
    openingVirtualExtentMinimumScrollHeight,
    virtualPageSegments,
    shouldShowPageSkeleton,
    isPageRenderFailed,
    isSpreadSingle,
    isPageBuffered,
    isPageRenderedForClass,
    getPageScale,
    getPagePlaceholderStyle,
    getExactPagePlaceholderStyle,
    bottomVirtualSpacerStyle,
    pendingImagePlacement,
    isPendingImagePlacementFinalizing,
    handleViewportScroll,
    handleViewerWheel,
    handleViewerMouseDown,
    handleViewerMouseMove,
    handleViewerMouseUp,
    handleViewerMouseLeave,
    handleViewerClick,
    handleViewerDblClick,
    handleViewerContextMenu,
    handleSelectStart,
    handlePageContainerMounted,
    handlePageContainerUnmounted,
    updatePendingImagePlacementRect,
    requestPendingImagePlacementFinalize,
    clearPendingImagePlacement,
    regionSnip,
    cropSelection,
    visibleLinksByPage,
    isViewerLoadingOverlayVisible,
    handleLinkDestination,
    handleViewerContainerRef,
    pdfViewerPublicApi,
} = controller;
const showInitialSurfacePlaceholder = computed(() => (
    injectedChassisAuthority === null
    && isViewerLoadingOverlayVisible.value
    && props.isActive !== false
));

const initialSurfacePlaceholderPageStyle = computed(() => buildPdfInitialSurfacePlaceholderStyle({
    pageStyle: getPagePlaceholderStyle(1),
    scaledMargin: scaledMargin.value,
    viewportOwnsPadding: injectedChassisAuthority !== null,
}));
const committedInitialPageNumber = computed(() => Math.max(1, Math.trunc(props.currentPage ?? 1)));
const openingPageFrameOwnerId = createPdfOpeningPageFrameOwnerId();
const openingPageFrameOwnedByRenderer = computed(() => (
    chassisAuthority?.openSurface.snapshot.value.openingPageFrame?.ownerId === openingPageFrameOwnerId
));
const openingPageFrameRecord = computed<IPdfOpeningPageFrameRecord | null>(() => {
    const frame = chassisAuthority?.openSurface.snapshot.value.openingPageFrame;
    if (!frame) {
        return null;
    }
    const [
        zoomMode,
        zoom,
    ] = frame.intentKey.split(':');
    return {
        generation: frame.generation,
        pageNumber: frame.pageNumber,
        zoomMode: zoomMode as IPdfOpeningPageFrameRecord['zoomMode'],
        zoom: Number(zoom),
        style: frame.style,
    };
});
const canonicalOpeningPageStyle = computed(() => buildPdfCommittedOpenPageShellStyle({pageStyle: getExactPagePlaceholderStyle(committedInitialPageNumber.value)}));
// A navigation request can supersede page 1 while the same empty-to-document
// generation is still opening. Keep the generation-fenced frame as the
// provisional geometry owner for the requested page, then replace its visual
// projection with exact target metrics as soon as they are available. The
// open-surface frame itself remains owned by the authority that committed it.
const projectedOpeningPageStyle = computed(() => (
    canonicalOpeningPageStyle.value ?? openingPageFrameRecord.value?.style ?? null
));
const showCommittedInitialPageShell = computed(() => (
    isCommittedInitialPageTransition.value
    && chassisAuthority?.openSurface.viewportSession.value.visual.kind === 'page'
));
function shouldShowViewportPageSkeleton(pageNumber: number) {
    const viewportSession = chassisAuthority?.openSurface.viewportSession.value;
    const visual = viewportSession?.visual;
    if (visual) {
        return shouldShowPdfViewportPageSkeleton({
            fallbackVisible: shouldShowPageSkeleton(pageNumber),
            isEmptyToDocumentTransition: isCommittedInitialPageTransition.value,
            isViewportTransitionActive: viewportSession.lifecycle !== 'ready',
            pageNumber,
            totalPages: chassisAuthority?.pageCount.value ?? 0,
            viewMode: props.viewMode ?? 'single',
            visual,
        });
    }
    return shouldShowPageSkeleton(pageNumber);
}
const shouldApplyOpeningPageFrame = computed(() => {
    const snapshot = chassisAuthority?.openSurface.snapshot.value;
    const frame = openingPageFrameRecord.value;
    return Boolean(snapshot && shouldApplyPdfOpeningPageFrame({
        activeGeneration: snapshot.generation,
        frameGeneration: frame?.generation ?? null,
        phase: snapshot.phase,
    }));
});
const hasProjectedOpeningPageFrame = computed(() => (
    shouldApplyOpeningPageFrame.value
    && projectedOpeningPageStyle.value !== null
));

watchEffect(() => {
    if (!chassisAuthority) {
        return;
    }
    const snapshot = chassisAuthority.openSurface.snapshot.value;
    const pageNumber = committedInitialPageNumber.value;
    const zoomMode = props.zoomMode ?? 'fit-width';
    const zoom = props.zoom ?? 1;
    const isOpeningTransition = snapshot.phase === 'pending'
        || snapshot.phase === 'geometry-committed'
        || snapshot.phase === 'canvas-committed'
        || snapshot.phase === 'viewport-committed';
    const current = openingPageFrameRecord.value;
    const intentKey = `${zoomMode}:${String(zoom)}`;
    if (
        current
        && (
            current.generation !== snapshot.generation
            || current.pageNumber !== pageNumber
            || current.zoomMode !== zoomMode
            || current.zoom !== zoom
        )
    ) {
        if (openingPageFrameOwnedByRenderer.value) {
            chassisAuthority.openSurface.clearOpeningPageFrame(snapshot.generation, openingPageFrameOwnerId);
        }
        return;
    }
    if (
        !isOpeningTransition
        || openingPageFrameRecord.value !== null
    ) {
        return;
    }
    const style = canonicalOpeningPageStyle.value;
    if (!style) {
        return;
    }
    const frame = createPdfOpeningPageFrameRecord({
        generation: snapshot.generation,
        pageNumber,
        zoom,
        zoomMode,
        style: {...style},
    });
    chassisAuthority.openSurface.commitOpeningPageFrame(snapshot.generation, {
        generation: frame.generation,
        ownerId: openingPageFrameOwnerId,
        pageNumber: frame.pageNumber,
        intentKey,
        style: frame.style,
    });
});

watchEffect(() => {
    if (!chassisAuthority) {
        return;
    }
    const snapshot = chassisAuthority.openSurface.snapshot.value;
    if (snapshot.phase === 'ready' && openingPageFrameOwnedByRenderer.value) {
        chassisAuthority.openSurface.clearOpeningPageFrame(snapshot.generation, openingPageFrameOwnerId);
    }
});

let openingGeometryAnimationFrame: number | null = null;
let openingGeometryDisposed = false;
function commitOpeningPageGeometryAfterDomUpdate(
    expectedGeneration: number,
    pageNumber: number,
) {
    if (
        openingGeometryDisposed
        || !showCommittedInitialPageShell.value
        || !chassisAuthority
        || openingPageFrameRecord.value === null
        || chassisAuthority.openSurface.snapshot.value.generation !== expectedGeneration
        || committedInitialPageNumber.value !== pageNumber
    ) {
        return false;
    }
    const diagnostic = initialPageSkeletonGeometry.diagnosePdfPageSkeletonGeometry(
        chassisAuthority,
        viewerContainer,
        committedInitialPageNumber,
        scaledMargin,
        pageNumber,
        {
            expectedGeneration,
            minimumScrollHeight: openingVirtualExtentMinimumScrollHeight.value,
        },
    );
    if (!diagnostic.canCommit) {
        return false;
    }
    const didCommit = chassisAuthority.openSurface.commitGeometry(
        expectedGeneration,
        diagnostic.geometry,
    );
    return didCommit;
}

async function handleOpeningPageContainerMounted(pageNumber: number) {
    alignProvisionalOpeningPageShell(pageNumber);
    handlePageContainerMounted(pageNumber);
    if (!chassisAuthority || pageNumber !== committedInitialPageNumber.value) {
        return;
    }
    const expectedGeneration = chassisAuthority.openSurface.snapshot.value.generation;
    await nextTick();
    if (commitOpeningPageGeometryAfterDomUpdate(expectedGeneration, pageNumber)) {
        return;
    }
    const pageContainer = viewerContainer.value?.querySelector<HTMLElement>(
        `.page_container[data-page="${String(pageNumber)}"]`,
    );
    const rect = pageContainer?.getBoundingClientRect();
    if (!rect || rect.width > 0 && rect.height > 0) {
        return;
    }
    if (openingGeometryAnimationFrame !== null) {
        cancelAnimationFrame(openingGeometryAnimationFrame);
    }
    openingGeometryAnimationFrame = requestAnimationFrame(() => {
        openingGeometryAnimationFrame = null;
        commitOpeningPageGeometryAfterDomUpdate(expectedGeneration, pageNumber);
    });
}

function alignProvisionalOpeningPageShell(pageNumber: number) {
    if (!chassisAuthority || pageNumber !== committedInitialPageNumber.value) {
        return false;
    }
    const snapshot = chassisAuthority.openSurface.snapshot.value;
    const visual = chassisAuthority.openSurface.viewportSession.value.visual;
    const container = viewerContainer.value;
    const pageContainer = container?.querySelector<HTMLElement>(
        `.page_container[data-page="${String(pageNumber)}"]`,
    );
    if (
        !container
        || !pageContainer
        || snapshot.phase === 'ready'
        || snapshot.phase === 'failed'
        || snapshot.committedViewport !== null
        || visual.kind !== 'page'
        || visual.pageNumber !== pageNumber
        || visual.presentation === 'canvas'
        || chassisAuthority.openSurface.viewportSession.value.requestedPage !== pageNumber
    ) {
        return false;
    }
    if (pageNumber === 1) {
        // The chassis resets every new document generation to the canonical
        // origin synchronously. Re-measuring the transient page-1 track here
        // used to write a 4 px scroll offset while its layout was still
        // settling; the opening shell then appeared 4 px above the final page.
        // Page 1 requires no virtual-spacer alignment.
        if (container.scrollTop === 0 && container.scrollLeft === 0) {
            return false;
        }
        const intent = chassisAuthority.viewportWritePort.beginIntent(
            `opening-page-origin:${String(snapshot.generation)}`,
        );
        return chassisAuthority.viewportWritePort.apply(container, {
            intent,
            reason: 'opening-page-origin',
            left: 0,
            top: 0,
        });
    }
    const containerRect = container.getBoundingClientRect();
    const pageRect = pageContainer.getBoundingClientRect();
    const viewportCenterY = Math.max(containerRect.top, 0)
        + Math.min(containerRect.height, window.innerHeight - Math.max(containerRect.top, 0)) / 2;
    if (
        pageRect.width <= 0
        || pageRect.height <= 0
        || pageRect.top <= viewportCenterY && pageRect.bottom >= viewportCenterY
    ) {
        return false;
    }
    const paddingTop = Number.parseFloat(window.getComputedStyle(container).paddingTop) || 0;
    const top = Math.max(
        0,
        container.scrollTop + pageRect.top - containerRect.top - paddingTop,
    );
    const intent = chassisAuthority.viewportWritePort.beginIntent(
        `opening-page-shell:${String(snapshot.generation)}:${String(pageNumber)}`,
    );
    return chassisAuthority.viewportWritePort.apply(container, {
        intent,
        reason: 'opening-page-shell-alignment',
        top,
    });
}

// Exact PDF metrics can replace the provisional virtual extent without
// remounting the target page. Reassert physical ownership after each Vue DOM
// flush until the canonical viewport transaction commits, otherwise the
// changed offsets can put the old row back under the viewport for one RAF.
watchPostEffect(() => {
    void virtualPageSegments.value;
    void projectedOpeningPageStyle.value;
    void chassisAuthority?.openSurface.snapshot.value.geometry;
    alignProvisionalOpeningPageShell(committedInitialPageNumber.value);
});

function handleOpeningPageContainerUnmounted(pageNumber: number) {
    handlePageContainerUnmounted(pageNumber);
    if (pageNumber === committedInitialPageNumber.value && openingGeometryAnimationFrame !== null) {
        cancelAnimationFrame(openingGeometryAnimationFrame);
        openingGeometryAnimationFrame = null;
    }
}

onBeforeUnmount(() => {
    openingGeometryDisposed = true;
    if (openingGeometryAnimationFrame !== null) {
        cancelAnimationFrame(openingGeometryAnimationFrame);
        openingGeometryAnimationFrame = null;
    }
    if (!chassisAuthority) {
        return;
    }
    const snapshot = chassisAuthority.openSurface.snapshot.value;
    chassisAuthority.openSurface.clearOpeningPageFrame(snapshot.generation, openingPageFrameOwnerId);
});

defineExpose(pdfViewerPublicApi);
</script>
<style lang="scss" src="@app/assets/css/pdf-viewer.scss"></style>
