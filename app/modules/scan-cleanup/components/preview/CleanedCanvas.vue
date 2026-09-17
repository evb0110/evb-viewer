<template>
    <div class="cleaned-outputs" :class="{'is-spread': outputs.length > 1}">
        <div v-for="output in outputs" :key="output.metadata.half" class="output-column">
            <div
                :ref="element => $emit('set-fit-area', output.metadata.half, element)"
                class="output-fit-area"
                :data-output-half="output.metadata.half"
            >
                <div
                    :ref="element => $emit('set-canvas', output.metadata.half, element)"
                    class="uniform-canvas"
                    :class="{'has-uniform-canvas': matchPageSize}"
                    :style="output.canvasStyle"
                    :data-frame-width="output.placement.canvasWidthPx"
                    :data-frame-height="output.placement.canvasHeightPx"
                    :data-render-dpi="output.metadata.renderDpi"
                    :data-matched-canvas-width-points="output.metadata.matchedCanvasTargetWidthPoints ?? undefined"
                    :data-matched-canvas-height-points="output.metadata.matchedCanvasTargetHeightPoints ?? undefined"
                >
                    <div
                        class="placed-image"
                        :class="{
                            'is-draggable': matchPageSize,
                            'is-drag-placeholder': activePlacementHalf === output.metadata.half,
                        }"
                        :style="output.imageStyle"
                        :data-content-width="output.placement.contentWidthPx"
                        :data-content-height="output.placement.contentHeightPx"
                        :data-source-region-width="output.metadata.sourceRegion.widthPx"
                        :data-input-width="output.metadata.inputWidthPx"
                    >
                        <div class="fold-clipped-pixels" :style="output.sourceCropStyle">
                            <img
                                v-if="output.pixelSwap.outgoingUrl"
                                :key="output.pixelSwap.outgoingUrl"
                                class="cleaned-image preview-pixel is-outgoing"
                                :src="output.pixelSwap.outgoingUrl"
                                alt=""
                            >
                            <img
                                v-if="output.pixelSwap.currentUrl"
                                :key="output.pixelSwap.currentUrl"
                                class="cleaned-image preview-pixel"
                                :class="{'is-entering': output.pixelSwap.entering}"
                                :src="output.pixelSwap.currentUrl"
                                :alt="altByHalf[output.metadata.half] ?? ''"
                                @transitionend="$emit('complete', output.metadata.half, output.pixelSwap.currentUrl)"
                                @transitioncancel="$emit('complete', output.metadata.half, output.pixelSwap.currentUrl)"
                            >
                            <img
                                v-if="output.pixelSwap.incomingUrl"
                                :key="output.pixelSwap.incomingUrl"
                                class="cleaned-image preview-pixel is-incoming"
                                :src="output.pixelSwap.incomingUrl"
                                alt=""
                                @load="$emit('load', output.metadata.half, output.pixelSwap.incomingUrl)"
                            >
                            <img
                                v-if="detailUrls[output.metadata.half]"
                                class="cleaned-image preview-detail-pixel"
                                :src="detailUrls[output.metadata.half]"
                                :style="detailStyles?.[output.metadata.half] ?? {inset: '0'}"
                                alt=""
                                aria-hidden="true"
                            >
                        </div>
                    </div>
                    <span
                        v-if="showMarginBoundary && hasAppliedMargins(output)"
                        class="margin-boundary-overlay"
                        :style="output.marginBoundaryStyle"
                        aria-hidden="true"
                    />
                    <slot name="paper-overlay" :output="output" />
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import type {
    ComponentPublicInstance,
    CSSProperties,
} from 'vue';
import type {TScanCleanupOutputHalf} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {IRenderedScanCleanupOutput} from '@app/modules/scan-cleanup/runtime/scanCleanupPreviewPresentation';

defineProps<{
    activePlacementHalf: TScanCleanupOutputHalf | null;
    altByHalf: Partial<Record<TScanCleanupOutputHalf, string>>;
    detailUrls: Partial<Record<TScanCleanupOutputHalf, string>>;
    detailStyles?: Partial<Record<TScanCleanupOutputHalf, CSSProperties>>;
    matchPageSize: boolean;
    outputs: IRenderedScanCleanupOutput[];
    showMarginBoundary?: boolean;
}>();
defineEmits<{
    complete: [half: TScanCleanupOutputHalf, url: string];
    load: [half: TScanCleanupOutputHalf, url: string];
    'set-canvas': [half: TScanCleanupOutputHalf, element: Element | ComponentPublicInstance | null];
    'set-fit-area': [half: TScanCleanupOutputHalf, element: Element | ComponentPublicInstance | null];
}>();
defineSlots<{'paper-overlay': (props: {output: IRenderedScanCleanupOutput}) => unknown}>();

function hasAppliedMargins(output: IRenderedScanCleanupOutput) {
    const margins = output.metadata.appliedMargins;
    return margins.leftPx > 0 || margins.topPx > 0 || margins.rightPx > 0 || margins.bottomPx > 0;
}
</script>
