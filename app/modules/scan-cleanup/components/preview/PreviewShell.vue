<template>
    <section
        class="preview-pane"
        :aria-label="t('scanCleanup.preview.title')"
        :aria-disabled="disabled || undefined"
        :tabindex="disabled ? -1 : 0"
        @keydown="handlePaneKeydown"
    >
        <header class="preview-header">
            <div class="page-navigation">
                <UButton
                    type="button"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    square
                    icon="i-ph-caret-left"
                    :aria-label="t('scanCleanup.preview.previous')"
                    :disabled="disabled || pageNumber <= 1"
                    @click="$emit('previous')"
                />
                <ScanCleanupStableWidthText
                    class="page-label"
                    :text="t('scanCleanup.preview.page', {page: pageNumber, total: totalPages})"
                    :widest="t('scanCleanup.preview.page', {page: totalPages, total: totalPages})"
                />
                <UButton
                    type="button"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    square
                    icon="i-ph-caret-right"
                    :aria-label="t('scanCleanup.preview.next')"
                    :disabled="disabled || pageNumber >= totalPages"
                    @click="$emit('next')"
                />
            </div>
            <div class="preview-controls">
                <div
                    class="preview-zoom-controls"
                    role="group"
                    :aria-label="t('scanCleanup.preview.zoomControls')"
                >
                    <AppTooltip
                        :disabled="disabled"
                        :text="t('scanCleanup.preview.zoomOut')"
                        usefulness="always"
                    >
                        <button
                            type="button"
                            class="preview-zoom-button"
                            :aria-label="t('scanCleanup.preview.zoomOut')"
                            :disabled="zoomControlsDisabled || !canZoomOut"
                            @click="stepPreviewZoom(-1)"
                        >
                            <UIcon name="i-ph-minus" class="preview-zoom-icon" />
                        </button>
                    </AppTooltip>
                    <AppTooltip
                        :disabled="disabled"
                        :text="t('scanCleanup.preview.toggleZoom', {zoom: previewZoomLabel})"
                        usefulness="always"
                    >
                        <button
                            type="button"
                            class="preview-zoom-value"
                            :aria-label="t('scanCleanup.preview.toggleZoom', {zoom: previewZoomLabel})"
                            :disabled="zoomControlsDisabled"
                            @click="toggleFitAndActualSize"
                        >
                            {{ previewZoomLabel }}
                        </button>
                    </AppTooltip>
                    <AppTooltip
                        :disabled="disabled"
                        :text="t('scanCleanup.preview.zoomIn')"
                        usefulness="always"
                    >
                        <button
                            type="button"
                            class="preview-zoom-button"
                            :aria-label="t('scanCleanup.preview.zoomIn')"
                            :disabled="zoomControlsDisabled || !canZoomIn"
                            @click="stepPreviewZoom(1)"
                        >
                            <UIcon name="i-ph-plus" class="preview-zoom-icon" />
                        </button>
                    </AppTooltip>
                    <AppTooltip
                        :disabled="disabled"
                        :text="t('scanCleanup.preview.fitPage')"
                        usefulness="always"
                    >
                        <button
                            type="button"
                            class="preview-zoom-button is-fit-page"
                            :class="{'is-active': previewZoomMode === 'fit'}"
                            :aria-label="t('scanCleanup.preview.fitPage')"
                            :aria-pressed="previewZoomMode === 'fit'"
                            :disabled="zoomControlsDisabled"
                            @click="fitPreview"
                        >
                            <UIcon name="i-ph-frame-corners" class="preview-zoom-icon" />
                        </button>
                    </AppTooltip>
                </div>
                <AppTooltip
                    :disabled="disabled"
                    usefulness="always"
                    :delay-duration="150"
                    class="preview-overlay-help"
                >
                    <UButton
                        type="button"
                        class="preview-overlay-help-trigger"
                        color="neutral"
                        variant="ghost"
                        size="sm"
                        square
                        icon="i-ph-info"
                        :aria-label="t('scanCleanup.preview.legend')"
                        :disabled="disabled"
                        @click.stop.prevent
                    />

                    <template #content>
                        <div
                            class="preview-overlay-tooltip"
                            :aria-label="t('scanCleanup.preview.legend')"
                        >
                            <span><i class="legend-swatch is-content" />{{ t('scanCleanup.preview.contentBox') }}</span>
                            <span><i class="legend-swatch is-margin" />{{ t('scanCleanup.preview.marginBox') }}</span>
                            <span v-if="matchPageSize"><i class="legend-swatch is-canvas" />{{ t('scanCleanup.preview.canvas') }}</span>
                        </div>
                    </template>
                </AppTooltip>
                <ScanCleanupSegmented
                    :model-value="effectiveViewMode"
                    :items="viewModes"
                    :disabled="disabled"
                    :group-label="t('scanCleanup.preview.comparison')"
                    @update:model-value="$emit('update:viewMode', $event as 'original' | 'cleaned')"
                />
            </div>
        </header>

        <div
            ref="previewSurface"
            class="preview-surface"
            :class="{
                'is-disabled': disabled,
                'is-stale-page': staleContentVisible,
                'can-pan-preview': canPanPreview,
                'is-panning-preview': panGesture !== null,
            }"
            :data-preview-zoom-mode="previewZoomMode"
            :data-preview-zoom-percent="Math.round(previewEffectiveZoom * 100)"
            :aria-disabled="disabled || undefined"
            aria-live="polite"
            @dblclick="handlePreviewDoubleClick"
            @pointercancel="finishPreviewPan"
            @pointerdown="startPreviewPan"
            @pointermove="movePreviewPan"
            @pointerup="finishPreviewPan"
            @lostpointercapture="finishPreviewPan"
            @wheel="handlePreviewWheel"
        >
            <div
                v-if="!requestedPageLoadingVisible && (result || rawLayerVisible)"
                class="preview-result-layer"
                :data-testid="result ? undefined : 'scan-cleanup-original-only'"
                :class="{
                    'is-cutter-source-dimmed': cutterSourceUnderlayVisible,
                    'is-source-underlay-dimmed': sourceUnderlayVisible,
                }"
            >
                <div
                    v-if="presentationResult && presentationResult.outputs.length === 0 && effectiveViewMode === 'cleaned'"
                    class="preview-message"
                    :class="{'is-stale-content': staleContentVisible}"
                >
                    <span>{{ presentationResult.pageMetadata.excluded
                        ? t('scanCleanup.preview.excluded')
                        : t('scanCleanup.preview.blankSkipped') }}</span>
                </div>
                <div v-else class="preview-viewport-layout">
                    <div
                        ref="cutterStage"
                        class="cutter-stage"
                        :class="{'is-stale-content': staleContentVisible}"
                        :style="previewTransformStyle"
                    >
                        <OriginalCanvas
                            v-if="rawLayerVisible"
                            class="preview-comparison-layer"
                            :class="{'is-visible': originalLayerVisible}"
                            :aria-hidden="!originalLayerVisible"
                            :alt="t('scanCleanup.preview.originalAlt', {page: result?.pageNumber ?? pageNumber})"
                            :crop-overlay-styles="losslessCropOverlayStyles"
                            :inert="!originalLayerVisible"
                            :pixel-swap="rawPixelSwap"
                            @complete="completeRawPixelSwap"
                            @load="loadRawPixelSwap"
                        />
                        <CleanedCanvas
                            v-if="presentationResult && !lossless"
                            class="preview-comparison-layer"
                            :class="{'is-visible': cleanedLayerVisible}"
                            :aria-hidden="!cleanedLayerVisible"
                            :active-placement-half="activePlacementHalf"
                            :alt-by-half="cleanedAltByHalf"
                            :detail-styles="detailRegionStyles"
                            :detail-urls="detailResultMatchesPage ? detailPixelUrls : {}"
                            :inert="!cleanedLayerVisible"
                            :match-page-size="matchPageSize"
                            :outputs="renderedOutputs"
                            :show-margin-boundary="showMarginBoundary"
                            @complete="completeCleanedPixelSwap"
                            @load="loadCleanedPixelSwap"
                            @set-canvas="setOutputCanvas"
                            @set-fit-area="setOutputFitArea"
                        >
                            <template v-if="!disabled" #paper-overlay="{output}">
                                <PlacementOverlay
                                    :anchors="placementAnchors"
                                    :enabled="matchPageSize"
                                    :labels="placementLabels"
                                    :outputs="placementOverlayOutputFor(output.metadata.half)"
                                    @abort="dragTransaction.abort"
                                    @cancel="dragTransaction.cancel"
                                    @finish="finishPlacementDrag"
                                    @lost-pointer-capture="dragTransaction.lostPointerCapture"
                                    @move="dragTransaction.move"
                                    @nudge="nudgePlacement"
                                    @start="startPlacementDrag"
                                />
                                <ContentBoxOverlay
                                    :group-labels="contentGroupLabels"
                                    :handle-labels="contentHandleLabels"
                                    :handles="contentHandles"
                                    :outputs="contentOverlayOutputFor(output.metadata.half)"
                                    @abort="dragTransaction.abort"
                                    @cancel="dragTransaction.cancel"
                                    @finish="dragTransaction.finish"
                                    @lost-pointer-capture="dragTransaction.lostPointerCapture"
                                    @move="dragTransaction.move"
                                    @nudge="nudgeContentBox"
                                    @reset="emit('update:manualContentBox', $event, null)"
                                    @start="startContentDrag"
                                />
                            </template>
                        </CleanedCanvas>
                    </div>
                    <span
                        class="preview-viewport-caption"
                        :aria-hidden="canvasNotice === ''"
                        :data-canvas-notice="canvasNoticeKind"
                    >
                        <template v-if="canvasNotice">
                            {{ canvasNotice }}
                        </template>
                    </span>
                </div>
                <div v-if="loading && staleContentVisible" class="page-loading-overlay" role="status">
                    <UIcon name="i-ph-circle-notch" class="size-6 is-spinning" />
                    <span>{{ t('scanCleanup.preview.loadingPage', {page: pageNumber}) }}</span>
                </div>
                <div v-else-if="loading" class="refresh-indicator">
                    <UIcon name="i-ph-circle-notch" class="size-4 is-spinning" />
                    <span class="sr-only">{{ t('scanCleanup.preview.refreshing') }}</span>
                </div>
                <div v-if="effectiveError && effectiveViewMode === 'cleaned'" class="preview-refresh-error" role="alert">
                    <span>{{ t('scanCleanup.preview.unavailable') }}</span>
                    <UButton
                        type="button"
                        color="neutral"
                        variant="outline"
                        size="xs"
                        :label="t('scanCleanup.preview.retry')"
                        :disabled="disabled"
                        @click="$emit('retry')"
                    />
                    <details class="preview-error-disclosure">
                        <summary>{{ t('scanCleanup.preview.technicalDetails') }}</summary>
                        <span class="preview-error-detail">{{ effectiveError }}</span>
                    </details>
                </div>
            </div>
            <div
                v-if="requestedPageLoadingVisible || (!result && !rawLayerVisible)"
                class="preview-empty-layer"
            >
                <div v-if="!effectiveError" class="preview-viewport-layout preview-loading" role="status">
                    <div ref="cutterStage" class="cutter-stage">
                        <div
                            class="cleaned-outputs preview-skeleton-outputs"
                            :class="{'is-spread': loadingFrames.length > 1}"
                        >
                            <div
                                v-for="output in loadingFrames"
                                :key="output.half"
                                class="output-column"
                            >
                                <div
                                    :ref="element => setOutputFitArea(output.half, element)"
                                    class="output-fit-area"
                                    :data-output-half="output.half"
                                >
                                    <div
                                        class="uniform-canvas preview-skeleton-page"
                                        :style="output.style"
                                        :data-frame-width="output.width"
                                        :data-frame-height="output.height"
                                    >
                                        <USkeleton class="preview-skeleton-fill" />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <span class="preview-viewport-caption">{{ t('scanCleanup.preview.loading') }}</span>
                </div>
                <div v-else class="preview-message is-error" role="alert">
                    <UIcon name="i-ph-warning-circle" class="size-6" />
                    <span>{{ t('scanCleanup.preview.unavailable') }}</span>
                    <UButton
                        type="button"
                        color="neutral"
                        variant="outline"
                        size="sm"
                        :label="t('scanCleanup.preview.retry')"
                        :disabled="disabled"
                        @click="$emit('retry')"
                    />
                    <details class="preview-error-disclosure">
                        <summary>{{ t('scanCleanup.preview.technicalDetails') }}</summary>
                        <span class="preview-error-detail">{{ effectiveError }}</span>
                    </details>
                </div>
            </div>
            <div
                v-if="result && !disabled && !requestedPageLoadingVisible"
                class="drag-overlay-layer"
                :style="[dragOverlayStyle, previewTransformStyle]"
            >
                <div
                    v-if="sourceUnderlayVisible"
                    class="cutter-source-underlay"
                    :style="cutterSourceFrameStyle"
                    aria-hidden="true"
                >
                    <img :src="rawPixelSwap.currentUrl" :style="cutterSourceImageStyle">
                </div>

                <CutterOverlay
                    :hint="t('scanCleanup.preview.cutterHint')"
                    :label="t('scanCleanup.preview.cutter')"
                    :refreshing="loading && !cutterSourceUnderlayVisible"
                    :style="cutterStyle"
                    :visible="showCutter"
                    @abort="dragTransaction.abort"
                    @cancel="dragTransaction.cancel"
                    @finish="dragTransaction.finish"
                    @lost-pointer-capture="dragTransaction.lostPointerCapture"
                    @move="dragTransaction.move"
                    @nudge="nudgeCutter"
                    @reset="emit('update:manualSplit', null)"
                    @start="startCutterDrag"
                />

                <ZoneEditorOverlay
                    v-if="zoneEditing"
                    :frame="cutterSourceFitPlacement"
                    :manual-zones="manualZones"
                    :rotation-degrees="rotationDegrees ?? 0"
                    :selected="selectedZone"
                    :zone-kind="zoneKind"
                    @update:manual-zones="emit('update:manualZones', $event)"
                    @update:selected="selectedZone = $event"
                />
            </div>
            <ZoneEditorControls
                v-if="result && zoneEditing && !disabled && !requestedPageLoadingVisible && outputMode !== undefined"
                :output-mode="outputMode"
                :selected-layer="selectedPictureLayer"
                :zone-count="zoneCount"
                :zone-kind="zoneKind"
                @update:selected-layer="updateSelectedPictureLayer"
                @update:zone-kind="zoneKind = $event"
                @use-mixed-output="emit('useMixedOutput')"
            />
            <aside
                v-if="showFirstRunGuidance && !zoneEditing"
                class="scan-cleanup-first-run-guidance"
                :aria-label="t('scanCleanup.firstRun.title')"
            >
                <strong>{{ t('scanCleanup.firstRun.title') }}</strong>
                <ol>
                    <li>{{ t('scanCleanup.firstRun.detect') }}</li>
                    <li>{{ t('scanCleanup.firstRun.review') }}</li>
                    <li>{{ t('scanCleanup.firstRun.cleanUp') }}</li>
                </ol>
                <UButton
                    type="button"
                    color="primary"
                    size="sm"
                    :label="t('scanCleanup.firstRun.dismiss')"
                    :disabled="disabled"
                    @click="$emit('dismiss-first-run-guidance')"
                />
            </aside>
        </div>

        <img
            v-for="pending in pendingCleanedPixels"
            :key="pending.url"
            class="preview-cleaned-pixel-preload"
            :src="pending.url"
            alt=""
            aria-hidden="true"
            @error="failCleanedPixelSwap(pending.half, pending.url)"
            @load="loadCleanedPixelSwap(pending.half, pending.url)"
        >

    </section>
</template>

<script setup lang="ts">
import type {
    IScanCleanupManualZones,
    IScanCleanupNormalizedRect,
    IScanCleanupNormalizedSplit,
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewRequest,
    IScanCleanupPixelRect,
    IScanCleanupRawPreviewResult,
    IScanCleanupPreviewResult,
    TScanCleanupOutputHalf,
    TScanCleanupOutputMode,
    TScanCleanupPageAlignment,
    TScanCleanupPageRotation,
} from '@contracts/electronApiScanCleanup';
import type {CSSProperties} from 'vue';
import type {IDocumentPageSource} from '@app/utils/document-viewer/source/documentPageSource';
import ScanCleanupSegmented from '@app/modules/scan-cleanup/components/ScanCleanupSegmented.vue';
import ScanCleanupStableWidthText from '@app/modules/scan-cleanup/components/ScanCleanupStableWidthText.vue';
import CleanedCanvas from '@app/modules/scan-cleanup/components/preview/CleanedCanvas.vue';
import ContentBoxOverlay from '@app/modules/scan-cleanup/components/preview/ContentBoxOverlay.vue';
import CutterOverlay from '@app/modules/scan-cleanup/components/preview/CutterOverlay.vue';
import OriginalCanvas from '@app/modules/scan-cleanup/components/preview/OriginalCanvas.vue';
import PlacementOverlay from '@app/modules/scan-cleanup/components/preview/PlacementOverlay.vue';
import ZoneEditorControls from '@app/modules/scan-cleanup/components/preview/ZoneEditorControls.vue';
import ZoneEditorOverlay from '@app/modules/scan-cleanup/components/preview/ZoneEditorOverlay.vue';
import type {
    IRenderedScanCleanupOutput,
    IScanCleanupContentOverlayOutput,
    IScanCleanupPlacementOverlayOutput,
    TScanCleanupContentHandle,
} from '@app/modules/scan-cleanup/runtime/scanCleanupPreviewPresentation';
import {
    type IScanCleanupDragRect,
    useScanCleanupDragTransaction,
} from '@app/modules/scan-cleanup/composables/useScanCleanupDragTransaction';
import {useScanCleanupViewportFrame} from '@app/modules/scan-cleanup/composables/useScanCleanupViewportFrame';
import {useScanCleanupZoneEditor} from '@app/modules/scan-cleanup/composables/useScanCleanupZoneEditor';
import {
    clampPreviewRect,
    expandPreviewRectByMargins,
    previewPointToSourceHalf,
    normalizeManualSplitX,
    normalizePreviewContentBox,
    resolveNormalizedContentBox,
    resolveNormalizedManualSplitX,
    scanCleanupAnalysisWidth,
    scanCleanupCutterRatio,
    scanCleanupCutterXFromRatio,
    transformPreviewContentBox,
    transformPreviewSourceHalfRect,
    unrotatePreviewRect,
} from '@app/modules/scan-cleanup/geometry/coordinates';
import {
    type IScanCleanupPreviewFitArea,
    type IScanCleanupPreviewFitPlacement,
    resolvePreviewFitPlacement,
    resolvePreviewOutputFitRects,
    resolvePreviewOutputFitSizes,
    resolvePreviewSpreadCutterCenter,
} from '@app/modules/scan-cleanup/geometry/viewport';
import {
    resolvePreviewMetadataPlacement,
    toPreviewSourceCropStyle,
    toPreviewStyleRect,
} from '@app/modules/scan-cleanup/geometry/placement';
import {
    createPreviewImageSwap,
    useScanCleanupPreviewImages,
} from '@app/modules/scan-cleanup/composables/useScanCleanupPreviewImages';
import {useScanCleanupPreviewZoom} from '@app/modules/scan-cleanup/composables/useScanCleanupPreviewZoom';
import {useScanCleanupPreviewOverlayGeometry} from '@app/modules/scan-cleanup/composables/useScanCleanupPreviewOverlayGeometry';

interface ICutterDragGeometry {
    kind: 'cutter';
    value: IScanCleanupNormalizedSplit;
}
interface IContentDragGeometry {
    half: TScanCleanupOutputHalf;
    kind: 'content';
    value: IScanCleanupNormalizedRect;
}
interface IPlacementDragGeometry {
    alignment: TScanCleanupPageAlignment;
    half: TScanCleanupOutputHalf;
    kind: 'placement';
    left: number;
    top: number;
}
type TScanCleanupDragGeometry = ICutterDragGeometry | IContentDragGeometry | IPlacementDragGeometry;
const props = defineProps<{
    result: IScanCleanupPreviewResult | null;
    resultCurrent?: boolean;
    resultPresentationKey?: string;
    detailResult?: IScanCleanupPreviewResult | null;
    rawResult?: IScanCleanupRawPreviewResult | null;
    loading: boolean;
    error: string;
    viewMode?: 'original' | 'cleaned';
    matchPageSize: boolean;
    alignment: TScanCleanupPageAlignment;
    pageNumber: number;
    totalPages: number;
    stalePage?: boolean;
    showMarginBoundary?: boolean;
    showFirstRunGuidance?: boolean;
    manualSplit: IScanCleanupNormalizedSplit | null;
    readingOrder: 'ltr' | 'rtl';
    manualContentBoxes?: Partial<Record<TScanCleanupOutputHalf, IScanCleanupNormalizedRect>>;
    manualZones?: IScanCleanupManualZones | undefined;
    placementOverrides?: Partial<Record<TScanCleanupOutputHalf, TScanCleanupPageAlignment>>;
    outputMode?: TScanCleanupOutputMode | undefined;
    zoneEditing?: boolean;
    disabled?: boolean;
    lossless?: boolean;
    source?: IDocumentPageSource | null;
    layoutClassification?: IScanCleanupPreviewMetadata['layoutClassification'] | undefined;
    layoutDetectionComplete?: boolean;
    rotationDegrees?: TScanCleanupPageRotation;
}>();
const emit = defineEmits<{
    'dismiss-first-run-guidance': [];
    previous: [];
    next: [];
    retry: [];
    'update:viewMode': [value: 'original' | 'cleaned'];
    'update:manualSplit': [value: IScanCleanupNormalizedSplit | null];
    'update:manualContentBox': [half: TScanCleanupOutputHalf, value: IScanCleanupNormalizedRect | null];
    'update:manualZones': [value: IScanCleanupManualZones];
    'update:placement': [half: TScanCleanupOutputHalf, value: TScanCleanupPageAlignment];
    useMixedOutput: [];
    invalidateDetail: [];
    requestDetail: [viewports: NonNullable<IScanCleanupPreviewRequest['detail']>['viewports']];
}>();
const {t} = useTypedI18n();
const previewSurface = ref<HTMLElement | null>(null);
const cutterStage = ref<HTMLElement | null>(null);
const dragTransaction = useScanCleanupDragTransaction<TScanCleanupDragGeometry>();
const contentHandles: readonly TScanCleanupContentHandle[] = [
    'n',
    'ne',
    'e',
    'se',
    's',
    'sw',
    'w',
    'nw',
];
const cutterStageSize = reactive({
    height: 0,
    width: 0,
});
const dragOverlayBounds = reactive<IScanCleanupDragRect>({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
});

interface IScanCleanupDisplayedFramePresentation {
    resultCurrent: boolean;
    settled: boolean;
}

function captureFramePresentation(): IScanCleanupDisplayedFramePresentation {
    // A frame built while the document plan is still open remains provisional
    // even if live detection settles while it is pinned.
    return {
        resultCurrent: props.resultCurrent === true,
        settled: props.layoutDetectionComplete === true,
    };
}

const {
    cleanedPixelSwaps,
    cleanedFrameError,
    completeCleanedPixelSwap,
    completeRawPixelSwap,
    detailPixelUrls,
    displayedCleanedFrame,
    displayedCleanedFrameCurrent,
    failCleanedPixelSwap,
    loadCleanedPixelSwap,
    loadRawPixelSwap,
    pendingCleanedPixelUrls,
    rawPixelSwap,
    revealLatestFrame,
} = useScanCleanupPreviewImages(() => props.result, (hadPreviousResult) => {
    void nextTick(() => {
        pruneOutputElementRefs();
        refreshFrozenViewportFrame();
        if (!hadPreviousResult) {
            observeCutterStage();
        }
    });
}, () => props.rawResult ?? null, () => props.detailResult ?? null,
() => captureFramePresentation(),
props.resultPresentationKey === undefined ? undefined : () => props.resultPresentationKey ?? '',
presentation => presentation.resultCurrent && presentation.settled);
const presentationResult = computed(() => displayedCleanedFrame.value?.result ?? null);
const effectiveError = computed(() => cleanedFrameError.value || props.error);
const displayedPresentation = computed(
    () => displayedCleanedFrame.value?.presentation ?? captureFramePresentation(),
);
const {
    canPanPreview,
    canZoomIn,
    canZoomOut,
    clampPreviewPan,
    finishPreviewPan,
    fitPreview,
    handlePreviewDoubleClick,
    handlePreviewWheel,
    movePreviewPan,
    panGesture,
    previewEffectiveZoom,
    previewPan,
    previewTransformScale,
    previewTransformStyle,
    previewZoomLabel,
    previewZoomMode,
    startPreviewPan,
    stepPreviewZoom,
    toggleFitAndActualSize,
} = useScanCleanupPreviewZoom({
    disabled: () => props.disabled === true,
    dragActive: dragTransaction.active,
    formatFitLabel: () => t('scanCleanup.preview.zoomFit'),
    formatZoomLabel: zoom => t('scanCleanup.preview.zoomValue', {zoom}),
    overlayBounds: dragOverlayBounds,
    result: () => presentationResult.value ?? props.rawResult ?? null,
    stageSize: cutterStageSize,
    surface: previewSurface,
    updateGeometry: () => updateOverlayGeometry(),
});
const {
    currentStageRect,
    observeCutterStage,
    outputCanvasRects,
    outputFitAreaSizes,
    placementAnchors: outerPlacementAnchors,
    pruneOutputElementRefs,
    setOutputCanvas,
    setOutputFitArea,
    updateOutputFitAreaSizes,
    updateOverlayGeometry,
} = useScanCleanupPreviewOverlayGeometry({
    activeDrag: dragTransaction.active,
    clampPan: clampPreviewPan,
    cutterStage,
    dragOverlayBounds,
    previewPan,
    previewSurface,
    result: () => presentationResult.value,
    stageSize: cutterStageSize,
    transformScale: previewTransformScale,
});
const effectiveViewMode = computed(() => props.lossless
    ? 'original'
    : props.viewMode ?? 'cleaned');
const zoomControlsDisabled = computed(() => props.disabled === true
    || (presentationResult.value ?? props.rawResult ?? null) === null);
const devicePixelScale = ref(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
let devicePixelMediaQuery: MediaQueryList | null = null;

function updateDevicePixelScale() {
    devicePixelScale.value = window.devicePixelRatio || 1;
}

function watchDevicePixelScale() {
    devicePixelMediaQuery?.removeEventListener('change', handleDevicePixelScaleChange);
    if (typeof window.matchMedia !== 'function') {
        devicePixelMediaQuery = null;
        return;
    }
    devicePixelMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    devicePixelMediaQuery.addEventListener('change', handleDevicePixelScaleChange);
}

function handleDevicePixelScaleChange() {
    updateDevicePixelScale();
    watchDevicePixelScale();
}
// Detail rendering starts as soon as the fixed-DPI base raster is stretched
// past one device pixel per raster pixel; the display density (not a zoom
// percentage) decides when the base bitmap runs out of resolution.
const detailDensityExceeded = computed(
    () => previewEffectiveZoom.value * devicePixelScale.value > 1.001,
);
const detailLayerEligible = computed(() => effectiveViewMode.value === 'cleaned'
    && props.lossless !== true
    // Deliberate degradation while pinned: detail tiles describe the live
    // generation and must not be composited onto a different displayed base.
    && displayedCleanedFrameCurrent.value
    && Boolean(presentationResult.value?.outputs.length)
    && detailDensityExceeded.value);
const detailResultMatchesPage = computed(() => detailLayerEligible.value
    && props.detailResult?.pageNumber === presentationResult.value?.pageNumber);
const detailRegionStyles = computed<Partial<Record<TScanCleanupOutputHalf, CSSProperties>>>(() => {
    if (!detailResultMatchesPage.value) {
        return {};
    }
    const styles: Partial<Record<TScanCleanupOutputHalf, CSSProperties>> = {};
    for (const output of props.detailResult?.outputs ?? []) {
        const region = output.metadata.renderRegion;
        if (!region) {
            styles[output.metadata.half] = {inset: '0'};
            continue;
        }
        styles[output.metadata.half] = {
            left: `${region.xPx / output.metadata.outputWidthPx * 100}%`,
            top: `${region.yPx / output.metadata.outputHeightPx * 100}%`,
            width: `${region.widthPx / output.metadata.outputWidthPx * 100}%`,
            height: `${region.heightPx / output.metadata.outputHeightPx * 100}%`,
        };
    }
    return styles;
});
const isStalePage = computed(() => props.stalePage
    || Boolean(props.result && props.result.pageNumber !== props.pageNumber));
// A source sheet is not a cleaned output. Until this page's cleaned result
// exists, Cleaned mode owns a topology-aware loading shell; the raw sheet is
// available only through Original mode. This prevents an unsplit landscape
// raster from ever masquerading as the first portrait output.
const requestedPageLoadingVisible = computed(() => effectiveViewMode.value === 'cleaned'
    && effectiveError.value === ''
    && props.result?.pageNumber !== props.pageNumber);
const rawLayerVisible = computed(() => props.rawResult?.pageNumber === props.pageNumber && (
    effectiveViewMode.value === 'original'
    || (
        props.result?.pageNumber === props.pageNumber
        && props.rawResult.pageNumber === props.pageNumber
    )
) || Boolean(props.lossless && props.result));
const originalLayerVisible = computed(() => rawLayerVisible.value
    && effectiveViewMode.value === 'original');
const cleanedLayerVisible = computed(() => Boolean(props.result) && !originalLayerVisible.value);
/**
 * Why the page the user is looking at may not be on the size they asked for.
 * Matched page size draws every page on one rectangle, measured from the
 * document's geometry and from the layouts detection has settled, so two things
 * can move it — and each is named here rather than left to be discovered as an
 * unexplained relayout. The caption line is always laid out, so saying this
 * costs no shift.
 */
const canvasNoticeKind = computed(() => {
    if (!presentationResult.value) {
        return '';
    }
    // This describes the displayed frame, not whichever detection generation
    // is live now. A frame rendered from an open plan stays provisional while
    // pinned. Once layout has settled, an older frame instead says that the
    // preview is updating and its placement still reflects previous settings.
    if (props.resultPresentationKey !== undefined && !displayedPresentation.value.settled) {
        return 'provisional';
    }
    if (
        dragTransaction.active.value
        || (
            props.resultPresentationKey !== undefined
            && (
                displayedCleanedFrame.value?.transitionKey !== props.resultPresentationKey
                || props.resultCurrent !== true
                || !displayedPresentation.value.resultCurrent
            )
        )
    ) {
        return 'updating';
    }
    if (!props.matchPageSize) {
        return '';
    }
    // The main process could not measure this document, so it dropped matching
    // for the request and drew the page at its own size.
    if (presentationResult.value.outputs.some(output => output.metadata.canvasPolicy === 'intrinsic')) {
        return 'unavailable';
    }
    return '';
});
const canvasNotice = computed(() => {
    if (canvasNoticeKind.value === 'unavailable') {
        return t('scanCleanup.preview.matchedCanvasUnavailable');
    }
    if (canvasNoticeKind.value === 'updating') {
        return t('scanCleanup.preview.updatingPreviousPlacement');
    }
    return canvasNoticeKind.value === 'provisional'
        ? t('scanCleanup.preview.matchedCanvasProvisional')
        : '';
});
const staleContentVisible = computed(() => isStalePage.value);
const viewModes = computed(() => props.lossless ? [{
    value: 'original' as const,
    label: t('scanCleanup.preview.preview'),
}] : [
    {
        value: 'original' as const,
        label: t('scanCleanup.preview.original'),
    },
    {
        value: 'cleaned' as const,
        label: t('scanCleanup.preview.cleaned'),
    },
]);
const dragOutputSnapshot = ref<IRenderedScanCleanupOutput[] | null>(null);

const {
    selectedPictureLayer,
    selectedZone,
    updateSelectedPictureLayer,
    zoneCount,
    zoneKind,
} = useScanCleanupZoneEditor({
    editing: () => props.zoneEditing,
    manualZones: () => props.manualZones,
    pageNumber: () => props.pageNumber,
    updateManualZones: value => emit('update:manualZones', value),
});
const {
    frame: frozenViewportFrame,
    placeholderHalves,
    refresh: refreshFrozenViewportFrame,
    sourceMetricsReady,
} = useScanCleanupViewportFrame({
    activeDrag: dragTransaction.active,
    fitAreaSizes: outputFitAreaSizes,
    layoutClassification: () => props.layoutClassification,
    matchPageSize: () => props.matchPageSize,
    requestedPage: () => props.pageNumber,
    result: () => presentationResult.value,
    rotationDegrees: () => props.rotationDegrees ?? 0,
    source: () => props.source ?? null,
});

const loadingFrames = computed(() => {
    const orderedHalves = props.readingOrder === 'rtl' && placeholderHalves.value.length > 1
        ? [...placeholderHalves.value].reverse()
        : placeholderHalves.value;
    const frames = orderedHalves.map(half => ({
        half,
        ...(frozenViewportFrame.value.outputs[half] ?? {
            width: 1,
            height: Math.SQRT2,
        }),
    }));
    const sizes = resolvePreviewOutputFitSizes(
        frames.map(frame => outputFitAreaSizes[frame.half] ?? {
            width: 0,
            height: 0,
        }),
        frames,
    );
    return frames.map((frame, index) => {
        const fitArea = outputFitAreaSizes[frame.half];
        const size = sizes[index];
        const width = size?.width ?? 0;
        const height = size?.height ?? 0;
        const measured = (fitArea?.width ?? 0) > 0
            && (fitArea?.height ?? 0) > 0
            && width > 0
            && height > 0;
        const visibility: CSSProperties['visibility'] = sourceMetricsReady.value ? undefined : 'hidden';
        return {
            ...frame,
            style: measured ? {
                width: `${width}px`,
                height: `${height}px`,
                visibility,
            } : {
                width: 'auto',
                maxWidth: '100%',
                height: 'var(--app-scan-preview-skeleton-height)',
                maxHeight: '100%',
                aspectRatio: `${frame.width} / ${frame.height}`,
                visibility,
            },
        };
    });
});

const analysisWidth = computed(() => {
    const metadata = presentationResult.value?.pageMetadata;
    if (!metadata) {
        return 1;
    }
    return scanCleanupAnalysisWidth(
        metadata,
        presentationResult.value.rawWidthPx,
        presentationResult.value.rawHeightPx,
    );
});
const analysisHeight = computed(() => {
    const rotation = presentationResult.value?.pageMetadata.rotationDegrees ?? 0;
    return rotation === 90 || rotation === 270
        ? presentationResult.value?.rawWidthPx ?? 1
        : presentationResult.value?.rawHeightPx ?? 1;
});
const draftGeometry = computed(() => dragTransaction.draftGeometry.value);
const activeCutterDraft = computed(() => draftGeometry.value?.kind === 'cutter'
    ? draftGeometry.value
    : null);
const activePlacementHalf = computed(() => draftGeometry.value?.kind === 'placement'
    ? draftGeometry.value.half
    : null);
const cutterXPx = computed(() => resolveNormalizedManualSplitX(props.manualSplit, analysisWidth.value)
    ?? presentationResult.value?.pageMetadata.cutterXPx
    ?? analysisWidth.value / 2);
const displayedCutterX = computed(() => activeCutterDraft.value
    ? resolveNormalizedManualSplitX(activeCutterDraft.value.value, analysisWidth.value) ?? cutterXPx.value
    : cutterXPx.value);
const showCutter = computed(() => props.zoneEditing !== true
    && (
        activeCutterDraft.value !== null
        || Boolean(presentationResult.value) && (
            presentationResult.value?.pageMetadata.layoutClassification === 'two-page-spread'
            || props.manualSplit !== null
        )
    ));
const originalFitPlacement = computed(() => resolvePreviewFitPlacement(
    cutterStageSize.width,
    cutterStageSize.height,
    presentationResult.value?.rawWidthPx ?? 1,
    presentationResult.value?.rawHeightPx ?? 1,
));
const cutterSourceFitPlacement = computed(() => resolvePreviewFitPlacement(
    cutterStageSize.width,
    cutterStageSize.height,
    analysisWidth.value,
    analysisHeight.value,
));
const cutterSourceUnderlayVisible = computed(() => activeCutterDraft.value !== null
    && effectiveViewMode.value === 'cleaned');
const sourceUnderlayVisible = computed(() => props.zoneEditing === true || cutterSourceUnderlayVisible.value);
const dragOverlayStyle = computed<CSSProperties>(() => ({
    left: `${dragOverlayBounds.x}px`,
    top: `${dragOverlayBounds.y}px`,
    width: `${dragOverlayBounds.width}px`,
    height: `${dragOverlayBounds.height}px`,
}));
const cutterSourceFrameStyle = computed<CSSProperties>(() => ({
    left: `${cutterSourceFitPlacement.value.left}px`,
    top: `${cutterSourceFitPlacement.value.top}px`,
    width: `${cutterSourceFitPlacement.value.width}px`,
    height: `${cutterSourceFitPlacement.value.height}px`,
}));
const cutterSourceImageStyle = computed<CSSProperties>(() => {
    const rotation = presentationResult.value?.pageMetadata.rotationDegrees ?? 0;
    const swapsAxes = rotation === 90 || rotation === 270;
    return {
        width: `${swapsAxes ? cutterSourceFitPlacement.value.height : cutterSourceFitPlacement.value.width}px`,
        height: `${swapsAxes ? cutterSourceFitPlacement.value.width : cutterSourceFitPlacement.value.height}px`,
        transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
    };
});
const losslessCropOverlayStyles = computed(() => {
    const result = presentationResult.value;
    if (!props.lossless || !result || originalFitPlacement.value.width <= 0) {
        return [];
    }
    return result.outputs.map(output => {
        const metadata = output.metadata;
        const content = resolveNormalizedContentBox(metadata, props.manualContentBoxes?.[metadata.half])
            ?? metadata.contentBox;
        const local = content ? expandPreviewRectByMargins(content, metadata.appliedMargins) : {
            xPx: 0,
            yPx: 0,
            widthPx: metadata.sourceRegion.widthPx,
            heightPx: metadata.sourceRegion.heightPx,
        };
        const rawRect = unrotatePreviewRect({
            xPx: metadata.sourceRegion.xPx + local.xPx,
            yPx: metadata.sourceRegion.yPx + local.yPx,
            widthPx: local.widthPx,
            heightPx: local.heightPx,
        }, metadata);
        return {
            insetInlineStart: `${originalFitPlacement.value.left + rawRect.xPx / result.rawWidthPx * originalFitPlacement.value.width}px`,
            insetBlockStart: `${originalFitPlacement.value.top + rawRect.yPx / result.rawHeightPx * originalFitPlacement.value.height}px`,
            width: `${rawRect.widthPx / result.rawWidthPx * originalFitPlacement.value.width}px`,
            height: `${rawRect.heightPx / result.rawHeightPx * originalFitPlacement.value.height}px`,
        };
    });
});
const cutterStyle = computed(() => {
    const sourceRatio = scanCleanupCutterRatio(displayedCutterX.value, analysisWidth.value);
    if (cutterSourceUnderlayVisible.value) {
        return {
            insetBlockEnd: 'auto',
            insetBlockStart: `${cutterSourceFitPlacement.value.top}px`,
            insetInlineStart: `${cutterSourceFitPlacement.value.left + cutterSourceFitPlacement.value.width * sourceRatio}px`,
            height: `${cutterSourceFitPlacement.value.height}px`,
        };
    }
    if (effectiveViewMode.value === 'original' && originalFitPlacement.value.width > 0) {
        return {
            insetBlockEnd: 'auto',
            insetBlockStart: `${originalFitPlacement.value.top}px`,
            insetInlineStart: `${originalFitPlacement.value.left + originalFitPlacement.value.width * sourceRatio}px`,
            height: `${originalFitPlacement.value.height}px`,
        };
    }
    const outputs = presentationResult.value?.outputs ?? [];
    const canvases = outputs.map(output => frozenViewportFrame.value.outputs[output.metadata.half] ?? {
        width: analysisWidth.value / Math.max(1, outputs.length),
        height: analysisHeight.value,
    });
    if (props.readingOrder === 'rtl' && canvases.length > 1) {
        canvases.reverse();
    }
    const orderedHalves = outputs.map(output => output.metadata.half);
    if (props.readingOrder === 'rtl' && orderedHalves.length > 1) {
        orderedHalves.reverse();
    }
    const areas = orderedHalves
        .map(half => outputFitAreaSizes[half])
        .filter((area): area is IScanCleanupPreviewFitArea => area !== undefined && 'left' in area && 'top' in area);
    const renderedGapCenter = areas.length === canvases.length
        ? resolvePreviewSpreadCutterCenter(
            resolvePreviewOutputFitRects(areas, canvases)
                .filter((area): area is IScanCleanupPreviewFitPlacement => 'left' in area && 'top' in area),
        )
        : null;
    if (renderedGapCenter !== null) {
        return {insetInlineStart: `${renderedGapCenter}px`};
    }
    const visualRatio = props.readingOrder === 'rtl' ? 1 - sourceRatio : sourceRatio;
    return {insetInlineStart: `${visualRatio * 100}%`};
});
function navigateFromKeyboard(direction: 'previous' | 'next') {
    if (props.disabled) {
        return;
    }
    if (direction === 'previous' && props.pageNumber > 1) emit('previous');
    if (direction === 'next' && props.pageNumber < props.totalPages) emit('next');
}
function handlePaneKeydown(event: KeyboardEvent) {
    if (event.target !== event.currentTarget) {
        return;
    }
    if (event.key === 'ArrowLeft') {
        event.preventDefault();
        navigateFromKeyboard('previous');
    } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        navigateFromKeyboard('next');
    }
}

function captureDragOutputSnapshot() {
    dragOutputSnapshot.value = renderedOutputs.value.map(output => ({
        ...output,
        canvasStyle: {...output.canvasStyle},
        imageStyle: {...output.imageStyle},
        placement: {...output.placement},
    }));
}

function outputHalfLabel(half: TScanCleanupOutputHalf) {
    return t(`scanCleanup.preview.outputHalf.${half}`);
}

function contentHandleLabel(handle: TScanCleanupContentHandle, half: TScanCleanupOutputHalf) {
    return t('scanCleanup.preview.resizeContent', {
        direction: t(`scanCleanup.preview.resizeDirections.${handle}`),
        half: outputHalfLabel(half),
    });
}

const outputHalves = computed(
    () => presentationResult.value?.outputs.map(output => output.metadata.half) ?? [],
);
const cleanedAltByHalf = computed(() => Object.fromEntries(outputHalves.value.map(half => [
    half,
    t('scanCleanup.preview.cleanedAlt', {
        page: presentationResult.value?.pageNumber ?? props.pageNumber,
        half: outputHalfLabel(half),
    }),
])));
const placementLabels = computed(() => Object.fromEntries(outputHalves.value.map(half => [
    half,
    t('scanCleanup.preview.placement', {half: outputHalfLabel(half)}),
])));
const contentGroupLabels = computed(() => Object.fromEntries(outputHalves.value.map(half => [
    half,
    t('scanCleanup.preview.contentBoxFor', {half: outputHalfLabel(half)}),
])));
const contentHandleLabels = computed(() => Object.fromEntries(outputHalves.value.map(half => [
    half,
    Object.fromEntries(contentHandles.map(handle => [
        handle,
        contentHandleLabel(handle, half),
    ])),
])));

function startCutterDrag(event: PointerEvent) {
    updateOverlayGeometry(true);
    const stageRect = currentStageRect();
    const sourceFrame = effectiveViewMode.value === 'cleaned'
        ? cutterSourceFitPlacement.value
        : originalFitPlacement.value;
    if (!stageRect || sourceFrame.width <= 0) {
        return;
    }
    const rotation = presentationResult.value?.pageMetadata.rotationDegrees ?? 0;
    const transformScale = Math.max(0.001, previewTransformScale.value);
    const canonicalGeometry: ICutterDragGeometry = {
        kind: 'cutter',
        value: props.manualSplit
            ? {...props.manualSplit}
            : normalizeManualSplitX(cutterXPx.value, analysisWidth.value, rotation),
    };
    const started = dragTransaction.start(event, {
        canonicalGeometry,
        stageRect,
        fitScale: sourceFrame.width * transformScale / Math.max(1, analysisWidth.value),
        update: (pointerEvent, snapshot) => {
            const ratio = (
                (pointerEvent.clientX - snapshot.stageRect.x) / transformScale
                - sourceFrame.left
            ) / sourceFrame.width;
            return {
                kind: 'cutter',
                value: normalizeManualSplitX(
                    scanCleanupCutterXFromRatio(ratio, analysisWidth.value),
                    analysisWidth.value,
                    rotation,
                ),
            };
        },
        commit: geometry => {
            if (geometry.kind === 'cutter') {
                emit('update:manualSplit', geometry.value);
            }
        },
    });
    if (started) {
        captureDragOutputSnapshot();
        dragTransaction.move(event);
    }
}

function nudgeCutter(direction: -1 | 1, coarse: boolean) {
    const step = analysisWidth.value * (coarse ? 0.05 : 0.01);
    emit('update:manualSplit', normalizeManualSplitX(Math.min(
        analysisWidth.value * 0.98,
        Math.max(analysisWidth.value * 0.02, cutterXPx.value + direction * step),
    ), analysisWidth.value, presentationResult.value?.pageMetadata.rotationDegrees ?? 0));
}

function sourcePointFromClient(
    clientX: number,
    clientY: number,
    output: IRenderedScanCleanupOutput,
    rect: IScanCleanupDragRect,
) {
    // Back through the normalization the page is presented under, so a pointer
    // lands on the raster pixel the metadata is written in.
    return previewPointToSourceHalf(output.metadata, {
        x: ((clientX - rect.x) / rect.width * output.placement.canvasWidthPx - output.placement.left)
            / output.placement.scaleX,
        y: ((clientY - rect.y) / rect.height * output.placement.canvasHeightPx - output.placement.top)
            / output.placement.scaleY,
    });
}

function startContentDrag(
    event: PointerEvent,
    output: IScanCleanupContentOverlayOutput,
    handle: TScanCleanupContentHandle,
) {
    updateOverlayGeometry(true);
    const canvasClientRect = outputCanvasRects[output.metadata.half] ?? output.canvasClientRect;
    if (!output.contentRect || canvasClientRect.width <= 0 || canvasClientRect.height <= 0) {
        return;
    }
    const startRect = {...output.contentRect};
    const manualContentBox = props.manualContentBoxes?.[output.metadata.half];
    const canonicalGeometry: IContentDragGeometry = {
        kind: 'content',
        half: output.metadata.half,
        value: manualContentBox
            ? {...manualContentBox}
            : normalizePreviewContentBox(output.metadata, startRect),
    };
    const stageRect = currentStageRect();
    if (!stageRect) {
        return;
    }
    const started = dragTransaction.start(event, {
        canonicalGeometry,
        stageRect,
        fitScale: canvasClientRect.width / Math.max(1, output.placement.canvasWidthPx),
        update: pointerEvent => {
            const point = sourcePointFromClient(
                pointerEvent.clientX,
                pointerEvent.clientY,
                output,
                canvasClientRect,
            );
            return {
                kind: 'content',
                half: output.metadata.half,
                value: normalizePreviewContentBox(
                    output.metadata,
                    point
                        ? resizedContentRect(startRect, handle, point, output.metadata)
                        : startRect,
                ),
            };
        },
        commit: geometry => {
            if (geometry.kind === 'content') {
                emit('update:manualContentBox', geometry.half, geometry.value);
            }
        },
    });
    if (started) {
        captureDragOutputSnapshot();
        dragTransaction.move(event);
    }
}

function resizedContentRect(
    rect: IScanCleanupPixelRect,
    handle: TScanCleanupContentHandle,
    point: {
        x: number;
        y: number
    },
    metadata: IScanCleanupPreviewMetadata,
) {
    const minimum = Math.max(1, Math.min(metadata.sourceRegion.widthPx, metadata.sourceRegion.heightPx) * 0.02);
    let left = rect.xPx;
    let top = rect.yPx;
    let right = rect.xPx + rect.widthPx;
    let bottom = rect.yPx + rect.heightPx;
    if (handle.includes('w')) left = Math.min(right - minimum, point.x);
    if (handle.includes('e')) right = Math.max(left + minimum, point.x);
    if (handle.includes('n')) top = Math.min(bottom - minimum, point.y);
    if (handle.includes('s')) bottom = Math.max(top + minimum, point.y);
    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(metadata.sourceRegion.widthPx, right);
    bottom = Math.min(metadata.sourceRegion.heightPx, bottom);
    return clampPreviewRect({
        xPx: left,
        yPx: top,
        widthPx: Math.max(minimum, right - left),
        heightPx: Math.max(minimum, bottom - top),
    }, metadata.sourceRegion.widthPx, metadata.sourceRegion.heightPx);
}

function nudgeContentBox(
    event: KeyboardEvent,
    output: IRenderedScanCleanupOutput,
    handle: TScanCleanupContentHandle,
) {
    if (!output.contentRect || !event.key.startsWith('Arrow')) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    const step = Math.max(1, Math.min(output.metadata.sourceRegion.widthPx, output.metadata.sourceRegion.heightPx)
        * (event.shiftKey ? 0.05 : 0.01));
    const point = {
        x: handle.includes('w') ? output.contentRect.xPx : output.contentRect.xPx + output.contentRect.widthPx,
        y: handle.includes('n') ? output.contentRect.yPx : output.contentRect.yPx + output.contentRect.heightPx,
    };
    if (event.key === 'ArrowLeft') point.x -= step;
    if (event.key === 'ArrowRight') point.x += step;
    if (event.key === 'ArrowUp') point.y -= step;
    if (event.key === 'ArrowDown') point.y += step;
    emit('update:manualContentBox', output.metadata.half, normalizePreviewContentBox(
        output.metadata,
        resizedContentRect(output.contentRect, handle, point, output.metadata),
    ));
}

function alignmentFromOffset(
    left: number,
    top: number,
    reference: ReturnType<typeof resolvePlacementDragReferenceRect>,
) {
    const relativeLeft = left - reference.originX;
    const relativeTop = top - reference.originY;
    const horizontal = reference.spanX <= 0 || relativeLeft / reference.spanX < 0.25
        ? 'left'
        : relativeLeft / reference.spanX > 0.75 ? 'right' : 'center';
    const vertical = reference.spanY <= 0 || relativeTop / reference.spanY < 0.25
        ? 'top'
        : relativeTop / reference.spanY > 0.75 ? 'bottom' : 'center';
    return vertical === 'center' && horizontal === 'center'
        ? 'center' as const
        : `${vertical}-${horizontal}` as TScanCleanupPageAlignment;
}

function resolvePlacementDragReferenceRect(
    metadata: IScanCleanupPreviewMetadata,
    retainedWidthPx: number,
    contentHeightPx: number,
) {
    const matchedCanvas = metadata.matchedCanvasContentWidthPx != null
        || metadata.matchedCanvasContentHeightPx != null;
    const originX = matchedCanvas ? metadata.appliedMargins.leftPx : 0;
    const originY = matchedCanvas ? metadata.appliedMargins.topPx : 0;
    const horizontalInsets = matchedCanvas
        ? metadata.appliedMargins.leftPx + metadata.appliedMargins.rightPx
        : 0;
    const verticalInsets = matchedCanvas
        ? metadata.appliedMargins.topPx + metadata.appliedMargins.bottomPx
        : 0;
    return {
        originX,
        originY,
        spanX: Math.max(0, metadata.canvasWidthPx - horizontalInsets - retainedWidthPx),
        spanY: Math.max(0, metadata.canvasHeightPx - verticalInsets - contentHeightPx),
    };
}

function resolveRetainedPlacementGeometry(output: IRenderedScanCleanupOutput) {
    const foldClipLeftPx = output.metadata.foldClipLeftPx ?? 0;
    const foldClipRightPx = output.metadata.foldClipRightPx ?? 0;
    const retainedWidthPx = Math.max(
        1,
        output.placement.contentWidthPx - foldClipLeftPx - foldClipRightPx,
    );
    return {
        foldClipLeftPx,
        retainedWidthPx,
        reference: resolvePlacementDragReferenceRect(
            output.metadata,
            retainedWidthPx,
            output.placement.contentHeightPx,
        ),
    };
}

function startPlacementDrag(event: PointerEvent, output: IScanCleanupPlacementOverlayOutput) {
    // At navigation zoom dragging the cleaned page pans the viewport; placement
    // still moves via keyboard nudge or by dragging at fit zoom.
    if (canPanPreview.value) {
        return;
    }
    updateOverlayGeometry(true);
    const canvasClientRect = outputCanvasRects[output.metadata.half] ?? output.canvasClientRect;
    if (!props.matchPageSize || canvasClientRect.width <= 0 || canvasClientRect.height <= 0) {
        return;
    }
    const {
        foldClipLeftPx,
        reference: alignmentReference,
    } = resolveRetainedPlacementGeometry(output);
    const initialRetainedLeft = output.placement.left + foldClipLeftPx;
    const canonicalGeometry: IPlacementDragGeometry = {
        kind: 'placement',
        half: output.metadata.half,
        alignment: output.alignment,
        left: output.placement.left,
        top: output.placement.top,
    };
    const stageRect = currentStageRect();
    if (!stageRect) {
        return;
    }
    const fitScale = canvasClientRect.width / Math.max(1, output.placement.canvasWidthPx);
    const started = dragTransaction.start(event, {
        canonicalGeometry,
        stageRect,
        fitScale,
        update: (pointerEvent, snapshot) => {
            const retainedLeft = Math.min(
                alignmentReference.originX + alignmentReference.spanX,
                Math.max(
                    alignmentReference.originX,
                    initialRetainedLeft
                    + (pointerEvent.clientX - snapshot.pointerStart.x) / snapshot.fitScale,
                ),
            );
            const left = retainedLeft - foldClipLeftPx;
            const top = Math.min(
                alignmentReference.originY + alignmentReference.spanY,
                Math.max(
                    alignmentReference.originY,
                    output.placement.top + (pointerEvent.clientY - snapshot.pointerStart.y) / snapshot.fitScale,
                ),
            );
            return {
                kind: 'placement',
                half: output.metadata.half,
                alignment: alignmentFromOffset(retainedLeft, top, alignmentReference),
                left,
                top,
            };
        },
        commit: geometry => {
            if (geometry.kind === 'placement') {
                emit('update:placement', geometry.half, geometry.alignment);
            }
        },
    });
    if (started) {
        captureDragOutputSnapshot();
        dragTransaction.move(event);
    }
}

function finishPlacementDrag(event: PointerEvent) {
    const snapshot = dragTransaction.snapshot.value;
    dragTransaction.move(event);
    const draft = dragTransaction.draftGeometry.value;
    if (
        snapshot?.pointerId === event.pointerId
        && snapshot.canonicalGeometry.kind === 'placement'
        && draft?.kind === 'placement'
        && draft.half === snapshot.canonicalGeometry.half
        && draft.left === snapshot.canonicalGeometry.left
        && draft.top === snapshot.canonicalGeometry.top
    ) {
        dragTransaction.cancel();
        return;
    }
    dragTransaction.finish(event);
}

function nudgePlacement(event: KeyboardEvent, output: IRenderedScanCleanupOutput) {
    if (!props.matchPageSize || !event.key.startsWith('Arrow')) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    const current = props.placementOverrides?.[output.metadata.half] ?? props.alignment;
    // `ink` is not on the nine-way compass. A nudge steps off it from the
    // compass position nearest to where the output was actually placed.
    const resolvedInkAlignment = () => {
        const {
            foldClipLeftPx,
            reference,
        } = resolveRetainedPlacementGeometry(output);
        return alignmentFromOffset(
            output.placement.left + foldClipLeftPx,
            output.placement.top,
            reference,
        );
    };
    const [
        vertical,
        horizontal = vertical,
    ] = (current === 'ink' ? resolvedInkAlignment() : current).split('-');
    const axes = [
        'left',
        'center',
        'right',
    ] as const;
    const verticalAxes = [
        'top',
        'center',
        'bottom',
    ] as const;
    let x = axes.indexOf(horizontal as typeof axes[number]);
    let y = verticalAxes.indexOf(vertical as typeof verticalAxes[number]);
    if (event.key === 'ArrowLeft') x = Math.max(0, x - 1);
    if (event.key === 'ArrowRight') x = Math.min(2, x + 1);
    if (event.key === 'ArrowUp') y = Math.max(0, y - 1);
    if (event.key === 'ArrowDown') y = Math.min(2, y + 1);
    const nextVertical = verticalAxes[y] ?? 'center';
    const nextHorizontal = axes[x] ?? 'center';
    const next = x === 1 && y === 1 ? 'center' : `${nextVertical}-${nextHorizontal}`;
    emit('update:placement', output.metadata.half, next as TScanCleanupPageAlignment);
}

defineExpose({revealLatestFrame});
const pendingCleanedPixels = computed(() => (
    Object.entries(pendingCleanedPixelUrls) as Array<[TScanCleanupOutputHalf, string]>
).map(([
    half,
    url,
]) => ({
    half,
    url,
})));

let detailTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDetailRequest() {
    emit('invalidateDetail');
    if (detailTimer !== null) {
        clearTimeout(detailTimer);
        detailTimer = null;
    }
    if (
        effectiveViewMode.value !== 'cleaned'
        || props.lossless === true
        || !presentationResult.value
        || presentationResult.value.outputs.length === 0
        || !displayedCleanedFrameCurrent.value
        || props.loading
        || isStalePage.value
        || !detailDensityExceeded.value
        || panGesture.value !== null
        || dragTransaction.active.value
        || cutterStageSize.width <= 0
        || cutterStageSize.height <= 0
    ) {
        return;
    }
    detailTimer = setTimeout(() => {
        detailTimer = null;
        updateOverlayGeometry();
        const surfaceRect = previewSurface.value?.getBoundingClientRect();
        if (!surfaceRect) {
            return;
        }
        const quantizeDown = (value: number) => Math.floor(value * 64) / 64;
        const quantizeUp = (value: number) => Math.ceil(value * 64) / 64;
        const viewports: NonNullable<IScanCleanupPreviewRequest['detail']>['viewports'] = {};
        for (const output of renderedOutputs.value) {
            const canvasRect = outputCanvasRects[output.metadata.half];
            if (!canvasRect || canvasRect.width <= 0 || canvasRect.height <= 0) continue;
            const imageRect = {
                x: canvasRect.x
                    + output.placement.left / output.placement.canvasWidthPx * canvasRect.width,
                y: canvasRect.y
                    + output.placement.top / output.placement.canvasHeightPx * canvasRect.height,
                width: output.placement.contentWidthPx
                    / output.placement.canvasWidthPx * canvasRect.width,
                height: output.placement.contentHeightPx
                    / output.placement.canvasHeightPx * canvasRect.height,
            };
            const left = Math.max(0, Math.min(1, (surfaceRect.left - imageRect.x) / imageRect.width));
            const top = Math.max(0, Math.min(1, (surfaceRect.top - imageRect.y) / imageRect.height));
            const right = Math.max(left, Math.min(
                1,
                (surfaceRect.right - imageRect.x) / imageRect.width,
            ));
            const bottom = Math.max(top, Math.min(
                1,
                (surfaceRect.bottom - imageRect.y) / imageRect.height,
            ));
            if (right <= left || bottom <= top) continue;
            const xNormalized = quantizeDown(left);
            const yNormalized = quantizeDown(top);
            viewports[output.metadata.half] = {
                xNormalized,
                yNormalized,
                widthNormalized: Math.max(1 / 64, Math.min(1, quantizeUp(right)) - xNormalized),
                heightNormalized: Math.max(1 / 64, Math.min(1, quantizeUp(bottom)) - yNormalized),
                rotationDegrees: presentationResult.value?.pageMetadata.rotationDegrees ?? 0,
            };
        }
        if (Object.keys(viewports).length > 0) emit('requestDetail', viewports);
    }, 300);
}

watch([
    effectiveViewMode,
    isStalePage,
    previewEffectiveZoom,
    devicePixelScale,
    () => previewPan.x,
    () => previewPan.y,
    panGesture,
    () => dragTransaction.active.value,
    () => props.loading,
    () => presentationResult.value?.pageNumber,
    displayedCleanedFrameCurrent,
    () => displayedCleanedFrame.value?.transitionKey,
], scheduleDetailRequest);
onMounted(() => {
    window.addEventListener('resize', handleDevicePixelScaleChange);
    watchDevicePixelScale();
});
onBeforeUnmount(() => {
    window.removeEventListener('resize', handleDevicePixelScaleChange);
    devicePixelMediaQuery?.removeEventListener('change', handleDevicePixelScaleChange);
    devicePixelMediaQuery = null;
    if (detailTimer !== null) clearTimeout(detailTimer);
});

watch(() => dragTransaction.active.value, active => {
    if (!active) {
        dragOutputSnapshot.value = null;
        void nextTick(() => {
            refreshFrozenViewportFrame();
            updateOverlayGeometry();
        });
    }
});
watch(() => props.disabled, disabled => {
    if (disabled) {
        dragTransaction.cancel();
    }
});
watch(previewTransformScale, () => {
    void nextTick(() => {
        updateOverlayGeometry();
        updateOutputFitAreaSizes();
    });
});
watch(() => presentationResult.value?.pageNumber, () => {
    void nextTick(() => {
        updateOverlayGeometry();
        clampPreviewPan();
    });
});
const renderedOutputs = computed(() => {
    if (dragTransaction.active.value && dragOutputSnapshot.value) {
        return dragOutputSnapshot.value;
    }
    if (!presentationResult.value) {
        return [];
    }
    const outputs = presentationResult.value.outputs.map((output): IRenderedScanCleanupOutput => {
        const metadata = output.metadata;
        const placement = resolvePreviewMetadataPlacement(metadata);
        const imageStyle = toPreviewStyleRect({
            xPx: 0,
            yPx: 0,
            widthPx: metadata.outputWidthPx,
            heightPx: metadata.outputHeightPx,
        }, placement);
        const marginBoundaryStyle = {
            left: `${metadata.appliedMargins.leftPx / Math.max(1, metadata.canvasWidthPx) * 100}%`,
            top: `${metadata.appliedMargins.topPx / Math.max(1, metadata.canvasHeightPx) * 100}%`,
            right: `${metadata.appliedMargins.rightPx / Math.max(1, metadata.canvasWidthPx) * 100}%`,
            bottom: `${metadata.appliedMargins.bottomPx / Math.max(1, metadata.canvasHeightPx) * 100}%`,
        };
        const manualContentRect = resolveNormalizedContentBox(
            metadata,
            props.manualContentBoxes?.[metadata.half],
        );
        const contentRect = manualContentRect ?? metadata.contentBox;
        const content = manualContentRect
            ? transformPreviewSourceHalfRect(metadata, contentRect)
            : transformPreviewContentBox(metadata);
        return {
            metadata,
            pixelSwap: cleanedPixelSwaps[metadata.half] ?? createPreviewImageSwap(),
            placement,
            sourceCropStyle: toPreviewSourceCropStyle(metadata),
            imageStyle,
            marginBoundaryStyle,
            contentRect,
            contentStyle: content ? toPreviewStyleRect(content, placement) : null,
            canvasStyle: {},
        };
    });
    const ordered = props.readingOrder === 'rtl' && outputs.length > 1
        ? outputs.reverse()
        : outputs;
    const sizes = resolvePreviewOutputFitSizes(
        ordered.map(output => outputFitAreaSizes[output.metadata.half] ?? {
            width: 0,
            height: 0,
        }),
        ordered.map(output => ({
            width: output.placement.canvasWidthPx,
            height: output.placement.canvasHeightPx,
        })),
    );
    return ordered.map((output, index) => ({
        ...output,
        canvasStyle: {
            width: `${sizes[index]?.width ?? 0}px`,
            height: `${sizes[index]?.height ?? 0}px`,
        },
    }));
});

function activeStageRect() {
    return dragTransaction.snapshot.value?.stageRect ?? currentStageRect() ?? {
        x: 0,
        y: 0,
        width: dragOverlayBounds.width,
        height: dragOverlayBounds.height,
    };
}

const contentOverlayOutputs = computed<IScanCleanupContentOverlayOutput[]>(() => {
    if (activeCutterDraft.value || props.zoneEditing) {
        return [];
    }
    const stageRect = activeStageRect();
    const draft = draftGeometry.value?.kind === 'content' ? draftGeometry.value : null;
    const outputs = dragTransaction.active.value && dragOutputSnapshot.value
        ? dragOutputSnapshot.value
        : renderedOutputs.value;
    return outputs.flatMap(output => {
        const canvasClientRect = outputCanvasRects[output.metadata.half] ?? {
            x: stageRect.x,
            y: stageRect.y,
            width: 0,
            height: 0,
        };
        const normalized = draft?.half === output.metadata.half
            ? draft.value
            : props.manualContentBoxes?.[output.metadata.half];
        const contentRect = resolveNormalizedContentBox(output.metadata, normalized) ?? output.contentRect;
        const transformed = normalized
            ? transformPreviewSourceHalfRect(output.metadata, contentRect)
            : transformPreviewContentBox(output.metadata);
        if (!contentRect || !transformed) {
            return [];
        }
        return [{
            ...output,
            canvasClientRect: {...canvasClientRect},
            contentRect,
            style: toPreviewStyleRect(transformed, output.placement),
        }];
    });
});

const placementOverlayOutputs = computed<IScanCleanupPlacementOverlayOutput[]>(() => {
    const stageRect = activeStageRect();
    if (!props.matchPageSize || activeCutterDraft.value || props.zoneEditing) {
        return [];
    }
    const draft = draftGeometry.value?.kind === 'placement' ? draftGeometry.value : null;
    const outputs = dragTransaction.active.value && dragOutputSnapshot.value
        ? dragOutputSnapshot.value
        : renderedOutputs.value;
    return outputs.flatMap(output => {
        const canvasClientRect = outputCanvasRects[output.metadata.half] ?? {
            x: stageRect.x,
            y: stageRect.y,
            width: 0,
            height: 0,
        };
        const active = draft?.half === output.metadata.half;
        const placement = active ? {
            ...output.placement,
            left: draft.left,
            top: draft.top,
        } : output.placement;
        return [{
            ...output,
            pixelSwap: cleanedPixelSwaps[output.metadata.half] ?? output.pixelSwap,
            active,
            alignment: active
                ? draft.alignment
                : props.placementOverrides?.[output.metadata.half] ?? props.alignment,
            canvasClientRect: {...canvasClientRect},
            canvasStyle: {inset: '0'},
            imageStyle: toPreviewStyleRect({
                xPx: 0,
                yPx: 0,
                widthPx: output.metadata.outputWidthPx,
                heightPx: output.metadata.outputHeightPx,
            }, placement),
        }];
    });
});

function placementAnchorPosition(axis: string, origin: number, span: number, contentSize: number) {
    const ratio = axis === 'left' || axis === 'top'
        ? 0
        : axis === 'right' || axis === 'bottom' ? 1 : 0.5;
    return origin + (span + contentSize) * ratio;
}

const placementAnchors = computed(() => {
    const output = placementOverlayOutputs.value.find(candidate => candidate.active);
    if (!output) {
        return outerPlacementAnchors;
    }
    const {
        reference,
        retainedWidthPx,
    } = resolveRetainedPlacementGeometry(output);
    return outerPlacementAnchors.map(anchor => {
        const axes = anchor.alignment.split('-');
        const vertical = axes[0] ?? 'center';
        const horizontal = axes[1] ?? vertical;
        return {
            alignment: anchor.alignment,
            style: {
                left: `${placementAnchorPosition(
                    horizontal,
                    reference.originX,
                    reference.spanX,
                    retainedWidthPx,
                ) / Math.max(1, output.placement.canvasWidthPx) * 100}%`,
                top: `${placementAnchorPosition(
                    vertical,
                    reference.originY,
                    reference.spanY,
                    output.placement.contentHeightPx,
                ) / Math.max(1, output.placement.canvasHeightPx) * 100}%`,
            },
        };
    });
});

function contentOverlayOutputFor(half: TScanCleanupOutputHalf) {
    const output = contentOverlayOutputs.value.find(candidate => candidate.metadata.half === half);
    return output ? [output] : [];
}

function placementOverlayOutputFor(half: TScanCleanupOutputHalf) {
    const output = placementOverlayOutputs.value.find(candidate => candidate.metadata.half === half);
    return output ? [output] : [];
}
</script>

<style src="./PreviewShell.css"></style>
<style>
.cutter-control {
    cursor: col-resize;
}

.content-overlay:hover .content-handle::after,
.content-overlay:focus-within .content-handle::after,
.content-handle:focus-visible::after {
    opacity: 1;
}
</style>
